/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessDescendantRunning, runGitCmd } from './executors';
import { GitWorktreeInfo } from './parsers';
import { getRepoRoot, listGitWorktrees, resolveMainRepoRootFromPath } from './worktreeManager';

const WORKTREE_CACHE_TTL_MS = 350;
const MAX_WORKTREE_CACHE_ENTRIES = 50;
let worktreeCacheGeneration = 0;
const inFlightWorktreeQueries = new Map<string, Promise<GitWorktreeInfo[]>>();
const worktreeQueryCache = new Map<string, { data: GitWorktreeInfo[]; timestamp: number }>();

function pruneWorktreeCache(now: number = Date.now()): void {
    for (const [key, entry] of worktreeQueryCache.entries()) {
        if (now - entry.timestamp > WORKTREE_CACHE_TTL_MS) {
            worktreeQueryCache.delete(key);
        }
    }
    while (worktreeQueryCache.size > MAX_WORKTREE_CACHE_ENTRIES) {
        const oldestKey = worktreeQueryCache.keys().next().value;
        if (oldestKey === undefined) break;
        worktreeQueryCache.delete(oldestKey);
    }
}

/**
 * Returns the current worktree cache entry count (for unit testing).
 */
export function getWorktreeQueryCacheSizeForTesting(): number {
    return worktreeQueryCache.size;
}

/**
 * Invalidates cached Git worktree queries so subsequent lookups fetch fresh repository state.
 */
export function invalidateWorktreeCache(): void {
    worktreeCacheGeneration++;
    worktreeQueryCache.clear();
    inFlightWorktreeQueries.clear();
}

/**
 * Collects Git worktree metadata across the given CWDs and open workspace folders, deduplicated and short-TTL cached.
 */
export async function getWorktreesForCwds(cwds: (string | undefined)[]): Promise<GitWorktreeInfo[]> {
    const now = Date.now();
    pruneWorktreeCache(now);

    const validCwds = Array.from(new Set(cwds.filter((c): c is string => Boolean(c)))).sort();
    const folderPaths = (vscode.workspace.workspaceFolders || []).map(wf => wf.uri.fsPath).sort();
    const cacheKey = JSON.stringify({ validCwds, folderPaths });

    const cached = worktreeQueryCache.get(cacheKey);
    if (cached && now - cached.timestamp <= WORKTREE_CACHE_TTL_MS) {
        return cached.data;
    }

    const inFlight = inFlightWorktreeQueries.get(cacheKey);
    if (inFlight) {
        return inFlight;
    }

    const gen = worktreeCacheGeneration;
    const queryPromise = (async () => {
        const allWorktrees: GitWorktreeInfo[] = [];
        const visitedRepos = new Set<string>();

        for (const cwd of validCwds) {
            try {
                const repoRoot = await getRepoRoot(cwd);
                if (repoRoot && !visitedRepos.has(repoRoot)) {
                    visitedRepos.add(repoRoot);
                    const wts = await listGitWorktrees(repoRoot);
                    allWorktrees.push(...wts);
                }
            } catch {
                // Ignore git inspection errors for non-git paths
            }
        }

        for (const folderPath of folderPaths) {
            try {
                const repoRoot = await getRepoRoot(folderPath);
                if (repoRoot && !visitedRepos.has(repoRoot)) {
                    visitedRepos.add(repoRoot);
                    const wts = await listGitWorktrees(repoRoot);
                    allWorktrees.push(...wts);
                }
            } catch {
                // Ignore git inspection errors
            }
        }

        if (gen === worktreeCacheGeneration) {
            const updatedAt = Date.now();
            worktreeQueryCache.set(cacheKey, { data: allWorktrees, timestamp: updatedAt });
            pruneWorktreeCache(updatedAt);
        }
        return allWorktrees;
    })().finally(() => {
        if (inFlightWorktreeQueries.get(cacheKey) === queryPromise) {
            inFlightWorktreeQueries.delete(cacheKey);
        }
    });

    inFlightWorktreeQueries.set(cacheKey, queryPromise);
    return queryPromise;
}

function tryRealpath(targetPath: string): string {
    try {
        return fs.realpathSync(targetPath);
    } catch {
        const parent = path.dirname(targetPath);
        if (parent && parent !== targetPath) {
            try {
                return path.join(fs.realpathSync(parent), path.basename(targetPath));
            } catch {
                // Fall back to original path when parent cannot be resolved
            }
        }
        return targetPath;
    }
}

/**
 * Computes a repository-relative POSIX path for git CLI calls, avoiding multi-root workspace folder prefixes.
 */
export function computeGitRelativePath(repoRoot: string, filePath: string): string {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel;
    }
    const realRel = path.relative(tryRealpath(repoRoot), tryRealpath(filePath)).replace(/\\/g, '/');
    if (realRel && !realRel.startsWith('..') && !path.isAbsolute(realRel)) {
        return realRel;
    }
    return filePath;
}

/**
 * Resolves the target workspace/git repository root and optional repo-relative file path
 * cleanly in both single-root and multi-root VS Code workspaces.
 */
export async function resolveGitContextForUri(
    resourceUri?: vscode.Uri,
    fallbackUri?: vscode.Uri
): Promise<{ cwd: string; targetFile: string } | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const contextUri = resourceUri || fallbackUri;

    let cwd: string | undefined;
    if (contextUri?.scheme === 'file' && contextUri.fsPath) {
        try {
            const repoRoot = await getRepoRoot(path.dirname(contextUri.fsPath));
            if (repoRoot) {
                cwd = repoRoot;
            }
        } catch {
            // Fall back to owning workspace folder
        }
        if (!cwd && typeof vscode.workspace.getWorkspaceFolder === 'function') {
            cwd = vscode.workspace.getWorkspaceFolder(contextUri)?.uri.fsPath;
        }
    }

    if (!cwd && workspaceFolders && workspaceFolders.length > 0) {
        const firstPath = workspaceFolders[0].uri.fsPath;
        cwd = (await getRepoRoot(firstPath).catch(() => null)) || firstPath;
    }

    if (!cwd) {
        return null;
    }

    let targetFile = '';
    if (resourceUri?.scheme === 'file' && resourceUri.fsPath) {
        targetFile = computeGitRelativePath(cwd, resourceUri.fsPath);
    } else if (resourceUri) {
        targetFile = vscode.workspace.asRelativePath(resourceUri, false);
    }

    return { cwd, targetFile };
}

/**
 * Resolves the primary (main) Git repository root for a path inside either the main repo or a linked worktree.
 */
export async function resolveMainRepositoryRoot(targetPath?: string): Promise<string | null> {
    return await resolveMainRepoRootFromPath(targetPath);
}

/**
 * Collects the active branch name and commit log summary relative to main/master/origin HEAD,
 * falling back cleanly to the most recent 15 commits for repositories using custom default branches.
 */
export async function collectBranchLogSummary(cwd: string): Promise<{ currentBranch: string; logOut: string }> {
    const branchOut = await runGitCmd(['branch', '--show-current'], cwd);
    const currentBranch = branchOut.trim() || 'HEAD detached';

    let baseBranch: string | null = null;
    const candidates = ['main', 'master'];
    for (const candidate of candidates) {
        const verified = (await runGitCmd(['rev-parse', '--verify', candidate], cwd).catch(() => '')).trim();
        if (verified) {
            baseBranch = candidate;
            break;
        }
    }
    if (!baseBranch) {
        const remoteHead = (await runGitCmd(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd).catch(() => '')).trim();
        if (remoteHead) {
            baseBranch = remoteHead.replace(/^refs\/remotes\//, '');
        }
    }

    let logOut = '';
    if (baseBranch && baseBranch !== currentBranch) {
        try {
            logOut = await runGitCmd(['log', `${baseBranch}..HEAD`, '--oneline'], cwd);
        } catch {
            logOut = '';
        }
    }

    if (!logOut.trim()) {
        logOut = await runGitCmd(['log', '-n', '15', '--oneline'], cwd);
    }

    return { currentBranch, logOut };
}

/**
 * Captures terminal selection if present, or falls back to the full terminal buffer,
 * using a unique sentinel clipboard marker so selections identical to prior clipboard
 * contents are still recognized accurately.
 */
export async function captureTerminalOutputWithClipboard(
    clipboard: { readText(): Thenable<string> | Promise<string>; writeText(value: string): Thenable<void> | Promise<void> },
    executeCommand: (command: string) => Thenable<any> | Promise<any>,
    options?: { selectAllFallback?: boolean }
): Promise<string> {
    const selectAllFallback = options?.selectAllFallback ?? true;
    let originalClipboard = '';
    try {
        originalClipboard = await clipboard.readText();
    } catch {
        // Ignore clipboard read errors
    }

    const sentinel = `__herdr_collie_terminal_sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    let sentinelWritten = false;
    try {
        await clipboard.writeText(sentinel);
        sentinelWritten = true;
    } catch {
        // Fallback when clipboard write fails
    }

    let outputText = '';
    try {
        await executeCommand('workbench.action.terminal.copySelection');
        const selectionText = await clipboard.readText();

        const hasSelection = sentinelWritten
            ? Boolean(selectionText && selectionText !== sentinel)
            : Boolean(selectionText && selectionText !== originalClipboard);

        if (hasSelection) {
            outputText = selectionText;
        } else if (selectAllFallback) {
            await executeCommand('workbench.action.terminal.selectAll');
            await executeCommand('workbench.action.terminal.copySelection');
            await executeCommand('workbench.action.terminal.clearSelection');
            const bufferText = await clipboard.readText();
            if (!sentinelWritten || bufferText !== sentinel) {
                outputText = bufferText;
            }
        }
    } catch {
        // Fallback or handle error
    } finally {
        try {
            await clipboard.writeText(originalClipboard);
        } catch {
            // Ignore clipboard restore errors
        }
    }

    return outputText;
}

/**
 * Checks if Herdr TUI process is actively running in the given terminal.
 */
export async function isHerdrRunningInTerminal(terminal: vscode.Terminal): Promise<boolean> {
    if (terminal.exitStatus !== undefined) {
        return false;
    }
    try {
        const pid = await terminal.processId;
        if (!pid || pid <= 0) {
            return false;
        }
        return await isProcessDescendantRunning(pid, 'herdr');
    } catch {
        return false;
    }
}
