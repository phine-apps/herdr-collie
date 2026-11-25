/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessDescendantRunning } from './executors';
import { GitWorktreeInfo } from './parsers';
import { getRepoRoot, listGitWorktrees } from './worktreeManager';

const WORKTREE_CACHE_TTL_MS = 350;
let worktreeCacheGeneration = 0;
const inFlightWorktreeQueries = new Map<string, Promise<GitWorktreeInfo[]>>();
const worktreeQueryCache = new Map<string, { data: GitWorktreeInfo[]; timestamp: number }>();

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
    const validCwds = Array.from(new Set(cwds.filter((c): c is string => Boolean(c)))).sort();
    const folderPaths = (vscode.workspace.workspaceFolders || []).map(wf => wf.uri.fsPath).sort();
    const cacheKey = JSON.stringify({ validCwds, folderPaths });

    const cached = worktreeQueryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp <= WORKTREE_CACHE_TTL_MS) {
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
            worktreeQueryCache.set(cacheKey, { data: allWorktrees, timestamp: Date.now() });
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
    if (contextUri?.fsPath) {
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
    if (resourceUri?.fsPath) {
        targetFile = computeGitRelativePath(cwd, resourceUri.fsPath);
    } else if (resourceUri) {
        targetFile = vscode.workspace.asRelativePath(resourceUri, false);
    }

    return { cwd, targetFile };
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
