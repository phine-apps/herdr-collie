/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import type * as vscodeTypes from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { execHerdr, isCommandAvailable, runGitCmd } from './executors';
import {
    parseGitWorktrees,
    GitWorktreeInfo,
    parsePanes,
    parseWorkspaces,
    parseSnapshotAgents,
    parseIntegrationStatus,
    parseIntegrationListResult,
    ParsedIntegrationInfo,
    normalizeIntegrationTargetForCli,
    normalizeIntegrationTargetForSocket,
    mapAgentCmdToIntegrationTarget
} from './parsers';
import { HerdrSocketClient } from './socketClient';
import {
    FailingPrCheckSummary,
    formatCodeFence,
    formatGitHubIssueTaskPrompt,
    GitHubIssueSummary,
    stripTerminalControlSequences
} from './formatters';

export type { FailingPrCheckSummary, GitHubIssueSummary };

let vscode: typeof vscodeTypes;
try {
    vscode = require('vscode');
} catch {
    // Running outside VS Code runtime (e.g. unit tests)
}

export interface WorktreeLaunchOptions {
    branchName: string;
    baseBranch?: string;
    agentCommand: string;
    prompt?: string;
    worktreeLocation?: 'sibling' | '.worktrees';
}

export interface AgentOptionItem {
    label: string;
    description: string;
    detail?: string;
    cmd: string;
    agentKind?: string;
    integrationTarget?: string;
    checkCmd?: { binary: string; args?: string[] };
}

export const SUPPORTED_AGENT_DEFINITIONS: AgentOptionItem[] = [
    { label: '$(hubot) Claude Code', description: 'claude', cmd: 'claude', agentKind: 'claude', integrationTarget: 'claude', checkCmd: { binary: 'claude' } },
    { label: '$(hubot) Antigravity CLI', description: 'agy', cmd: 'agy', agentKind: 'agy', integrationTarget: 'antigravity-cli', checkCmd: { binary: 'agy' } },
    { label: '$(hubot) Cursor Agent', description: 'cursor-agent', cmd: 'cursor-agent', agentKind: 'cursor', integrationTarget: 'cursor', checkCmd: { binary: 'cursor-agent' } },
    { label: '$(hubot) GitHub Copilot CLI', description: 'gh copilot', cmd: 'gh copilot', agentKind: 'copilot', integrationTarget: 'copilot', checkCmd: { binary: 'gh', args: ['copilot', '--help'] } },
    { label: '$(hubot) Codex CLI', description: 'codex', cmd: 'codex', agentKind: 'codex', integrationTarget: 'codex', checkCmd: { binary: 'codex' } },
    { label: '$(hubot) Gemini CLI', description: 'gemini', cmd: 'gemini', agentKind: 'gemini', checkCmd: { binary: 'gemini' } },
    { label: '$(hubot) OpenCode CLI', description: 'opencode', cmd: 'opencode', agentKind: 'opencode', integrationTarget: 'opencode', checkCmd: { binary: 'opencode' } },
    { label: '$(hubot) Kilo CLI', description: 'kilo', cmd: 'kilo', agentKind: 'kilo', integrationTarget: 'kilo', checkCmd: { binary: 'kilo' } },
    { label: '$(hubot) Devin CLI', description: 'devin', cmd: 'devin', agentKind: 'devin', integrationTarget: 'devin', checkCmd: { binary: 'devin' } },
    { label: '$(hubot) Cline CLI', description: 'cline', cmd: 'cline', agentKind: 'cline', checkCmd: { binary: 'cline' } },
    { label: '$(hubot) Droid CLI', description: 'droid', cmd: 'droid', agentKind: 'droid', integrationTarget: 'droid', checkCmd: { binary: 'droid' } },
    { label: '$(hubot) Amp CLI', description: 'amp', cmd: 'amp', agentKind: 'amp', checkCmd: { binary: 'amp' } },
    { label: '$(hubot) Grok CLI', description: 'grok', cmd: 'grok', agentKind: 'grok', integrationTarget: 'grok', checkCmd: { binary: 'grok' } },
    { label: '$(hubot) Kiro CLI', description: 'kiro', cmd: 'kiro', agentKind: 'kiro', checkCmd: { binary: 'kiro' } },
    { label: '$(hubot) Pi Agent', description: 'pi', cmd: 'pi', agentKind: 'pi', integrationTarget: 'pi', checkCmd: { binary: 'pi' } },
    { label: '$(hubot) OMP Agent', description: 'omp', cmd: 'omp', agentKind: 'omp', integrationTarget: 'omp', checkCmd: { binary: 'omp' } },
    { label: '$(hubot) MastraCode CLI', description: 'mastracode', cmd: 'mastracode', agentKind: 'mastracode', integrationTarget: 'mastracode', checkCmd: { binary: 'mastracode' } },
    { label: '$(hubot) Kimi CLI', description: 'kimi', cmd: 'kimi', agentKind: 'kimi', integrationTarget: 'kimi', checkCmd: { binary: 'kimi' } },
    { label: '$(hubot) Hermes CLI', description: 'hermes', cmd: 'hermes', agentKind: 'hermes', integrationTarget: 'hermes', checkCmd: { binary: 'hermes' } },
    { label: '$(hubot) Qoder CLI', description: 'qodercli', cmd: 'qodercli', agentKind: 'qodercli', integrationTarget: 'qodercli', checkCmd: { binary: 'qodercli' } },
    { label: '$(hubot) Qwen Code CLI', description: 'qwen', cmd: 'qwen', agentKind: 'qwen', integrationTarget: 'qwen', checkCmd: { binary: 'qwen' } },
    { label: '$(hubot) Letta CLI', description: 'letta', cmd: 'letta', agentKind: 'letta', integrationTarget: 'letta', checkCmd: { binary: 'letta' } }
];

/**
 * Generates a Herdr-compliant agent name matching `[a-z][a-z0-9_-]{0,31}` that is unique among `existingNames`.
 */
export function sanitizeAgentName(rawName: string, existingNames?: Set<string>): string {
    let base = (rawName || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[^a-z]+/, '')
        .replace(/[-_]+$/, '');

    if (!base || !/^[a-z]/.test(base)) {
        const cleaned = (rawName || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        base = cleaned ? `a-${cleaned}` : 'agent';
    }

    base = base.slice(0, 32);

    if (!existingNames || !existingNames.has(base)) {
        return base;
    }

    for (let i = 2; i <= 999; i++) {
        const suffix = `-${i}`;
        const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
        if (!existingNames.has(candidate)) {
            return candidate;
        }
    }
    return `a-${Date.now().toString(36)}`.slice(0, 32);
}

/**
 * Fetches current Herdr integration statuses via socket API (preferred) or CLI fallback.
 */
export async function fetchIntegrationStatuses(socketClient?: HerdrSocketClient): Promise<ParsedIntegrationInfo[]> {
    if (socketClient && socketClient.isConnected) {
        try {
            const raw = await socketClient.listIntegrations();
            const parsed = parseIntegrationListResult(raw);
            if (parsed.length > 0) {
                return parsed;
            }
        } catch {
            // Fall back to CLI status check
        }
    }

    return await new Promise<ParsedIntegrationInfo[]>((resolve) => {
        execHerdr(['integration', 'status'], (err: any, stdout: string) => {
            if (!err && stdout) {
                resolve(parseIntegrationStatus(stdout));
            } else {
                resolve([]);
            }
        });
    });
}

/**
 * Installs or updates a Herdr integration via socket API (preferred) or CLI fallback.
 */
export async function installHerdrIntegration(target: string, socketClient?: HerdrSocketClient): Promise<boolean> {
    const cliTarget = normalizeIntegrationTargetForCli(target);
    const socketTarget = normalizeIntegrationTargetForSocket(target);
    if (!cliTarget) return false;

    if (socketClient && socketClient.isConnected) {
        try {
            await socketClient.installIntegration(socketTarget);
            return true;
        } catch {
            // Fall back to CLI install
        }
    }

    return await new Promise<boolean>((resolve) => {
        execHerdr(['integration', 'install', cliTarget], (err: any) => {
            resolve(!err);
        });
    });
}

/**
 * Uninstalls a Herdr integration via socket API (preferred) or CLI fallback.
 */
export async function uninstallHerdrIntegration(target: string, socketClient?: HerdrSocketClient): Promise<boolean> {
    const cliTarget = normalizeIntegrationTargetForCli(target);
    const socketTarget = normalizeIntegrationTargetForSocket(target);
    if (!cliTarget) return false;

    if (socketClient && socketClient.isConnected) {
        try {
            await socketClient.uninstallIntegration(socketTarget);
            return true;
        } catch {
            // Fall back to CLI uninstall
        }
    }

    return await new Promise<boolean>((resolve) => {
        execHerdr(['integration', 'uninstall', cliTarget], (err: any) => {
            resolve(!err);
        });
    });
}

/**
 * Returns list of agent options filtered to only those installed on the user machine,
 * enriched with Herdr integration health state when available.
 */
export async function getInstalledAgentOptions(
    socketClient?: HerdrSocketClient,
    integrations?: ParsedIntegrationInfo[]
): Promise<AgentOptionItem[]> {
    const checks = await Promise.all(
        SUPPORTED_AGENT_DEFINITIONS.map(async (agent) => {
            if (!agent.checkCmd) return { agent, installed: true };
            const installed = await isCommandAvailable(agent.checkCmd.binary, agent.checkCmd.args);
            return { agent, installed };
        })
    );

    const integrationMap = new Map<string, ParsedIntegrationInfo>();
    if (integrations) {
        for (const info of integrations) {
            integrationMap.set(info.cliTarget, info);
        }
    }

    const installedAgents = checks
        .filter(c => c.installed)
        .map(c => {
            const agent = { ...c.agent };
            const targetKey = agent.integrationTarget || mapAgentCmdToIntegrationTarget(agent.cmd);
            const integration = targetKey ? integrationMap.get(targetKey) : undefined;
            if (integration) {
                if (integration.state === 'outdated') {
                    agent.description = `${c.agent.description} • ⚠️ ${l10n.t('integration outdated')}`;
                } else if (integration.state === 'not_installed') {
                    agent.description = `${c.agent.description} • ⚠️ ${l10n.t('integration not installed')}`;
                } else {
                    agent.description = `${c.agent.description} • ✓ ${l10n.t('integrated')}`;
                }
            }
            return agent;
        });

    return [
        ...installedAgents,
        { label: `$(terminal) ` + l10n.t('Bash / Zsh Shell'), description: l10n.t('Default interactive shell'), cmd: '' },
        { label: `$(edit) ` + l10n.t('Custom Command...'), description: l10n.t('Enter custom CLI command'), cmd: 'CUSTOM' }
    ];
}

/**
 * Safely quotes a string for POSIX-compliant shell command arguments
 */
export function quoteForShell(str: string): string {
    if (!str) return "''";
    return `'` + str.replace(/'/g, `'\\''`) + `'`;
}

/**
 * Builds the full agent launch command line string, appending the quoted prompt if provided
 */
export function buildAgentLaunchCommand(agentCmd: string, prompt?: string): string {
    const trimmedCmd = agentCmd.trim();
    // Normalize newlines in prompt to spaces to prevent terminal shell splitting / breakout
    const normalizedPrompt = prompt ? prompt.replace(/[\r\n]+/g, ' ').trim() : undefined;

    if (!trimmedCmd) {
        return '';
    }

    if (!normalizedPrompt) {
        return trimmedCmd;
    }

    return `${trimmedCmd} ${quoteForShell(normalizedPrompt)}`;
}

/**
 * Validates branch name for Git ref compliance and prevents option flag injection
 */
export function validateBranchName(val: string): string | null {
    if (!val || !val.trim()) return l10n.t('Branch name cannot be empty');
    const trimmed = val.trim();
    if (trimmed.startsWith('-')) return l10n.t('Branch name cannot start with a hyphen (-)');
    if (/\s/.test(trimmed)) return l10n.t('Branch name cannot contain spaces');
    if (/[\0~^:?*\[\\]|\.\.|\/\/|@\{/.test(trimmed)) return l10n.t('Branch name contains invalid Git ref characters');
    return null;
}

/**
 * Sanitizes branch name into a filesystem-safe directory slug
 */
export function sanitizeBranchSlug(branchName: string): string {
    return branchName.replace(/[\/\\:*?"<>|]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Resolves git repository root directory
 */
export async function getRepoRoot(cwd: string): Promise<string | null> {
    try {
        const stdout = await runGitCmd(['rev-parse', '--show-toplevel'], cwd);
        const root = stdout.trim();
        return root.length > 0 ? root : null;
    } catch {
        return null;
    }
}

/**
 * Lists all git worktrees for a repository
 */
export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeInfo[]> {
    try {
        const stdout = await runGitCmd(['worktree', 'list', '--porcelain'], repoRoot);
        return parseGitWorktrees(stdout);
    } catch {
        return [];
    }
}

/**
 * Lists local git branch names
 */
export async function listGitBranches(repoRoot: string): Promise<string[]> {
    try {
        const stdout = await runGitCmd(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoRoot);
        return stdout.split('\n').map(b => b.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Gets current active git branch name
 */
export async function getCurrentGitBranch(repoRoot: string): Promise<string> {
    try {
        const stdout = await runGitCmd(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
        return stdout.trim();
    } catch {
        return 'main';
    }
}

/**
 * Creates a git worktree and checks out / creates the branch
 */
export async function createWorktree(
    repoRoot: string, 
    branchName: string, 
    worktreePath: string, 
    baseBranch?: string
): Promise<void> {
    const validationError = validateBranchName(branchName);
    if (validationError) {
        throw new Error(validationError);
    }

    const branches = await listGitBranches(repoRoot);
    const branchExists = branches.includes(branchName);

    const args = branchExists
        ? ['worktree', 'add', '--', worktreePath, branchName]
        : ['worktree', 'add', '-b', branchName, '--', worktreePath, baseBranch || 'HEAD'];

    await runGitCmd(args, repoRoot);
}

export const DEFAULT_WORKTREE_COPY_FILES: string[] = [
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.test.local'
];

export interface WorktreeBootstrapOptions {
    copyFiles?: string[];
    postCreateCommand?: string;
    timeoutMs?: number;
}

export interface WorktreeBootstrapResult {
    copiedFiles: string[];
    skippedFiles: string[];
    postCreateRan: boolean;
    postCreateSucceeded: boolean;
    warnings: string[];
}

/**
 * Reads worktree bootstrap settings (`worktree.copyFiles` and `worktree.postCreateCommand`) from VS Code configuration.
 */
export function getWorktreeBootstrapOptions(): WorktreeBootstrapOptions {
    const config = vscode?.workspace?.getConfiguration
        ? vscode.workspace.getConfiguration('herdr-collie')
        : undefined;
    const configuredCopyFiles = config?.get<unknown>('worktree.copyFiles');
    const copyFiles = Array.isArray(configuredCopyFiles)
        ? configuredCopyFiles.filter((f): f is string => typeof f === 'string')
        : [...DEFAULT_WORKTREE_COPY_FILES];
    const rawCmd = config?.get<string>('worktree.postCreateCommand', '');
    const postCreateCommand = typeof rawCmd === 'string' ? rawCmd.trim() : '';
    return { copyFiles, postCreateCommand };
}

function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
    const rel = path.relative(rootDir, candidatePath);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeRealpathOrResolve(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/**
 * Bootstraps a newly created Git worktree by copying configured untracked files (e.g. `.env*`)
 * from `repoRoot` and optionally running `postCreateCommand` in `worktreePath`.
 * Failures are captured as non-fatal warnings so agent provisioning can proceed.
 */
export async function bootstrapWorktreeEnvironment(
    repoRoot: string,
    worktreePath: string,
    options?: WorktreeBootstrapOptions
): Promise<WorktreeBootstrapResult> {
    const copiedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const warnings: string[] = [];

    const copyFiles = options?.copyFiles ?? DEFAULT_WORKTREE_COPY_FILES;
    const realRepoRoot = safeRealpathOrResolve(repoRoot);
    const realWorktreeRoot = safeRealpathOrResolve(worktreePath);
    const seen = new Set<string>();

    for (const rawEntry of copyFiles) {
        if (typeof rawEntry !== 'string') continue;
        const trimmed = rawEntry.trim();
        if (!trimmed) continue;

        if (
            trimmed.includes('\0') ||
            path.isAbsolute(trimmed) ||
            /^[a-zA-Z]:/.test(trimmed) ||
            /^[\\/]/.test(trimmed)
        ) {
            skippedFiles.push(trimmed);
            warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
            continue;
        }

        const normalizedRel = path.normalize(trimmed).replace(/\\/g, '/').replace(/^\.\//, '');
        if (!normalizedRel || normalizedRel === '.' || normalizedRel === '..' || normalizedRel.startsWith('../')) {
            skippedFiles.push(trimmed);
            warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
            continue;
        }

        if (seen.has(normalizedRel)) {
            continue;
        }
        seen.add(normalizedRel);

        const srcCandidate = path.resolve(realRepoRoot, normalizedRel);
        if (!isPathInsideRoot(realRepoRoot, srcCandidate)) {
            skippedFiles.push(normalizedRel);
            warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
            continue;
        }

        if (!fs.existsSync(srcCandidate)) {
            skippedFiles.push(normalizedRel);
            continue;
        }

        let realSrc: string;
        try {
            realSrc = fs.realpathSync(srcCandidate);
            if (!isPathInsideRoot(realRepoRoot, realSrc)) {
                skippedFiles.push(normalizedRel);
                warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
                continue;
            }
            const stat = fs.statSync(realSrc);
            if (!stat.isFile()) {
                skippedFiles.push(normalizedRel);
                continue;
            }
        } catch (err: any) {
            skippedFiles.push(normalizedRel);
            warnings.push(l10n.t('Failed to copy {0}: {1}', normalizedRel, err?.message || String(err)));
            continue;
        }

        const destCandidate = path.resolve(realWorktreeRoot, normalizedRel);
        if (!isPathInsideRoot(realWorktreeRoot, destCandidate)) {
            skippedFiles.push(normalizedRel);
            warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
            continue;
        }

        let destLstat: fs.Stats | undefined;
        try {
            destLstat = fs.lstatSync(destCandidate);
        } catch {
            destLstat = undefined;
        }
        if (destLstat) {
            skippedFiles.push(normalizedRel);
            if (destLstat.isSymbolicLink()) {
                warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
            }
            continue;
        }

        const destDir = path.dirname(destCandidate);
        let probeDir = destDir;
        while (!fs.existsSync(probeDir)) {
            const parent = path.dirname(probeDir);
            if (parent === probeDir) break;
            probeDir = parent;
        }
        const realProbeDir = safeRealpathOrResolve(probeDir);
        if (realProbeDir !== realWorktreeRoot && !isPathInsideRoot(realWorktreeRoot, realProbeDir)) {
            skippedFiles.push(normalizedRel);
            warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
            continue;
        }

        try {
            fs.mkdirSync(destDir, { recursive: true });
            const realDestDir = safeRealpathOrResolve(destDir);
            if (realDestDir !== realWorktreeRoot && !isPathInsideRoot(realWorktreeRoot, realDestDir)) {
                skippedFiles.push(normalizedRel);
                warnings.push(l10n.t('Skipped unsafe path: {0}', trimmed));
                continue;
            }
            fs.copyFileSync(realSrc, destCandidate);
            copiedFiles.push(normalizedRel);
        } catch (err: any) {
            skippedFiles.push(normalizedRel);
            warnings.push(l10n.t('Failed to copy {0}: {1}', normalizedRel, err?.message || String(err)));
        }
    }

    const postCreateCmd = (options?.postCreateCommand || '').trim();
    if (!postCreateCmd) {
        return {
            copiedFiles,
            skippedFiles,
            postCreateRan: false,
            postCreateSucceeded: true,
            warnings
        };
    }

    if (vscode?.workspace && vscode.workspace.isTrusted === false) {
        warnings.push(l10n.t('Skipped postCreateCommand because the workspace is not trusted.'));
        return {
            copiedFiles,
            skippedFiles,
            postCreateRan: false,
            postCreateSucceeded: false,
            warnings
        };
    }

    const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60000;
    const env = Object.assign({}, process.env);
    delete env['HERDR_WORKSPACE'];
    delete env['HERDR_PANE_ID'];
    delete env['HERDR_PANE'];
    delete env['HERDR_AGENT'];
    delete env['HERDR_SESSION'];

    const isWin = process.platform === 'win32';
    const shellBin = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', postCreateCmd] : ['-c', postCreateCmd];

    const postCreateSucceeded = await new Promise<boolean>((resolve) => {
        cp.execFile(
            shellBin,
            shellArgs,
            { cwd: worktreePath, env, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
            (error: any, stdout: string, stderr: string) => {
                if (error) {
                    const rawDetail = (stderr && stderr.trim()) || (stdout && stdout.trim()) || error.message || String(error);
                    const compact = rawDetail.replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
                    warnings.push(l10n.t('postCreateCommand failed: {0}', compact));
                    resolve(false);
                    return;
                }
                resolve(true);
            }
        );
    });

    return {
        copiedFiles,
        skippedFiles,
        postCreateRan: true,
        postCreateSucceeded,
        warnings
    };
}

/**
 * Removes a git worktree
 */
export async function removeWorktree(
    repoRoot: string, 
    worktreePath: string, 
    force = false
): Promise<void> {
    const args = force 
        ? ['worktree', 'remove', '--force', '--', worktreePath] 
        : ['worktree', 'remove', '--', worktreePath];
    await runGitCmd(args, repoRoot);
}

/**
 * Merges a worktree branch into the active branch of current repo
 */
export async function mergeWorktreeBranch(repoRoot: string, branchName: string): Promise<string> {
    const validationError = validateBranchName(branchName);
    if (validationError) {
        throw new Error(validationError);
    }
    return await runGitCmd(['merge', '--', branchName], repoRoot);
}

export interface WorktreeMergeVerification {
    canMerge: boolean;
    hasUncommittedWorktreeChanges: boolean;
    uncommittedFiles: string[];
    hasConflicts: boolean;
    conflictingFiles: string[];
    targetBranch: string;
    errorDetails?: string;
}

/**
 * Extracts conflicting file names from git merge / merge-tree output
 */
export function parseMergeConflictFiles(output: string): string[] {
    if (!output) return [];
    const files = new Set<string>();
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/CONFLICT\s*\([^)]+\):\s*Merge conflict in\s+(.+)$/i);
        if (match && match[1]) {
            files.add(match[1].trim());
        }
    }
    return Array.from(files);
}

/**
 * Performs non-destructive pre-merge verification on a worktree branch (checks uncommitted worktree files and merge conflicts)
 */
export async function verifyWorktreeMerge(
    repoRoot: string,
    branchName: string,
    worktreePath?: string
): Promise<WorktreeMergeVerification> {
    const validationError = validateBranchName(branchName);
    if (validationError) {
        throw new Error(validationError);
    }

    const targetBranch = await getCurrentGitBranch(repoRoot);
    let resolvedWtPath = worktreePath;

    if (!resolvedWtPath) {
        const worktrees = await listGitWorktrees(repoRoot);
        const matched = worktrees.find(w => w.branch === branchName);
        if (matched) {
            resolvedWtPath = matched.worktree;
        }
    }

    const uncommittedFiles: string[] = [];
    if (resolvedWtPath && fs.existsSync(resolvedWtPath)) {
        try {
            const statusOut = await runGitCmd(['status', '--porcelain', '-uall'], resolvedWtPath);
            const statusLines = statusOut.split(/\r?\n/).filter(Boolean);
            for (const line of statusLines) {
                if (line.length >= 3) {
                    uncommittedFiles.push(line.substring(3).trim());
                }
            }
        } catch {
            // Ignore worktree status inspection failure
        }
    }

    let hasConflicts = false;
    let conflictingFiles: string[] = [];
    let errorDetails: string | undefined;

    try {
        await runGitCmd(['merge-tree', '--write-tree', 'HEAD', branchName], repoRoot);
    } catch (err: any) {
        const msg = String(err?.message || err || '');
        if (/CONFLICT|Merge conflict/i.test(msg)) {
            hasConflicts = true;
            conflictingFiles = parseMergeConflictFiles(msg);
            errorDetails = msg.trim();
        } else {
            // Fallback for older Git versions without `merge-tree --write-tree`
            try {
                const mergeBase = (await runGitCmd(['merge-base', 'HEAD', branchName], repoRoot)).trim();
                if (mergeBase) {
                    const classicOut = await runGitCmd(['merge-tree', mergeBase, 'HEAD', branchName], repoRoot);
                    if (classicOut.includes('<<<<<<<') || classicOut.includes('changed in both')) {
                        hasConflicts = true;
                        errorDetails = 'Merge conflict detected between HEAD and ' + branchName;
                    }
                }
            } catch {
                // Ignore fallback failure
            }
        }
    }

    const hasUncommittedWorktreeChanges = uncommittedFiles.length > 0;
    return {
        canMerge: !hasUncommittedWorktreeChanges && !hasConflicts,
        hasUncommittedWorktreeChanges,
        uncommittedFiles,
        hasConflicts,
        conflictingFiles,
        targetBranch,
        errorDetails
    };
}

export interface GitDiffShortStat {
    filesChanged: number;
    insertions: number;
    deletions: number;
}

export interface WorktreeScorecard {
    branchName: string;
    worktreePath: string;
    baseBranch: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    untrackedFiles: number;
    canMerge: boolean;
    hasConflicts: boolean;
    conflictingFilesCount: number;
    hasUncommittedChanges: boolean;
    uncommittedFilesCount: number;
    lspErrorCount: number;
}

/**
 * Parses `git diff --shortstat` output into file count, insertions, and deletions.
 */
export function parseGitDiffShortStat(output: string): GitDiffShortStat {
    if (!output || !output.trim()) {
        return { filesChanged: 0, insertions: 0, deletions: 0 };
    }
    const filesMatch = output.match(/(\d+)\s+files?\s+changed/i);
    const insMatch = output.match(/(\d+)\s+insertions?\(\+\)/i);
    const delMatch = output.match(/(\d+)\s+deletions?\(-\)/i);
    return {
        filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
        insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
        deletions: delMatch ? parseInt(delMatch[1], 10) : 0
    };
}

async function resolveWorktreeMergeBaseSafe(
    worktreePath: string,
    baseBranchHint?: string,
    branchName?: string
): Promise<{ baseRef: string; baseLabel: string; baseBranch?: string }> {
    if (vscode) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require('./reviewManager');
            if (mod && typeof mod.resolveWorktreeMergeBase === 'function') {
                return await mod.resolveWorktreeMergeBase(worktreePath, baseBranchHint, branchName);
            }
        } catch {
            // Fall through to lightweight git fallback
        }
    }

    const candidates = [baseBranchHint, 'main', 'master', 'origin/main', 'origin/master', 'develop']
        .filter((c): c is string => Boolean(c && c !== branchName));
    for (const candidate of candidates) {
        try {
            const exists = (await runGitCmd(['rev-parse', '--verify', '--quiet', candidate], worktreePath)).trim();
            if (!exists) continue;
            const mergeBase = (await runGitCmd(['merge-base', candidate, 'HEAD'], worktreePath)).trim();
            if (mergeBase) {
                return { baseRef: mergeBase, baseLabel: candidate, baseBranch: candidate };
            }
        } catch {
            // Try next candidate
        }
    }
    return { baseRef: 'HEAD', baseLabel: 'HEAD', baseBranch: baseBranchHint };
}

function collectWorkspaceErrorsSafe(worktreePath: string): { totalErrors: number } {
    if (!vscode) {
        return { totalErrors: 0 };
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('./agentHUD');
        if (mod && typeof mod.collectWorkspaceErrorsForAgent === 'function') {
            return mod.collectWorkspaceErrorsForAgent(worktreePath);
        }
    } catch {
        // Ignore when agentHUD/vscode is unavailable
    }
    return { totalErrors: 0 };
}

/**
 * Collects a comparison scorecard for a candidate Git worktree:
 * diff scale against merge-base, merge readiness/conflicts, and VS Code LSP error count.
 */
export async function collectWorktreeScorecard(
    repoRoot: string,
    worktreePath: string,
    branchName: string,
    baseBranchHint?: string
): Promise<WorktreeScorecard> {
    const worktreeExists = fs.existsSync(worktreePath);
    const [mergeBase, verification] = await Promise.all([
        worktreeExists
            ? resolveWorktreeMergeBaseSafe(worktreePath, baseBranchHint, branchName).catch(() => ({
                baseRef: 'HEAD',
                baseLabel: 'HEAD',
                baseBranch: baseBranchHint
            }))
            : Promise.resolve({ baseRef: 'HEAD', baseLabel: 'HEAD', baseBranch: baseBranchHint }),
        verifyWorktreeMerge(repoRoot, branchName, worktreePath).catch(() => ({
            canMerge: false,
            hasUncommittedWorktreeChanges: false,
            uncommittedFiles: [] as string[],
            hasConflicts: false,
            conflictingFiles: [] as string[],
            targetBranch: baseBranchHint || 'main'
        }))
    ]);

    const [shortStatOut, untrackedOut] = worktreeExists
        ? await Promise.all([
            runGitCmd(['diff', '--shortstat', mergeBase.baseRef], worktreePath).catch(() => ''),
            runGitCmd(['ls-files', '--others', '--exclude-standard'], worktreePath).catch(() => '')
        ])
        : ['', ''];

    const stat = parseGitDiffShortStat(shortStatOut);
    const untrackedFiles = untrackedOut.split(/\r?\n/).filter(Boolean).length;
    const lspSummary = collectWorkspaceErrorsSafe(worktreePath);

    return {
        branchName,
        worktreePath,
        baseBranch: mergeBase.baseBranch || verification.targetBranch || 'HEAD',
        filesChanged: stat.filesChanged + untrackedFiles,
        insertions: stat.insertions,
        deletions: stat.deletions,
        untrackedFiles,
        canMerge: worktreeExists && verification.canMerge,
        hasConflicts: verification.hasConflicts,
        conflictingFilesCount: verification.conflictingFiles.length,
        hasUncommittedChanges: verification.hasUncommittedWorktreeChanges,
        uncommittedFilesCount: verification.uncommittedFiles.length,
        lspErrorCount: lspSummary.totalErrors
    };
}

/**
 * Collects scorecards for multiple worktree candidates in parallel, keyed by `worktreePath`.
 */
export async function collectWorktreeScorecardMap(
    repoRoot: string,
    candidates: Array<{ worktree: string; branch?: string }>
): Promise<Map<string, WorktreeScorecard>> {
    const result = new Map<string, WorktreeScorecard>();
    if (!candidates || candidates.length === 0) {
        return result;
    }

    const baseBranchHint = await getCurrentGitBranch(repoRoot).catch(() => undefined);
    const entries = await Promise.all(
        candidates
            .filter(c => Boolean(c.worktree && c.branch))
            .map(async (c) => {
                try {
                    const card = await collectWorktreeScorecard(repoRoot, c.worktree, c.branch!, baseBranchHint);
                    return [c.worktree, card] as const;
                } catch {
                    return null;
                }
            })
    );

    for (const entry of entries) {
        if (entry) {
            result.set(entry[0], entry[1]);
        }
    }
    return result;
}

/**
 * Formats a concise single-line scorecard badge for QuickPick comparison UIs.
 */
export function formatWorktreeScorecardBadge(scorecard: WorktreeScorecard): string {
    let diffSegment: string;
    if (scorecard.filesChanged === 0 && scorecard.insertions === 0 && scorecard.deletions === 0) {
        diffSegment = l10n.t('No changes');
    } else if (scorecard.filesChanged === 1) {
        diffSegment = l10n.t('1 file (+{0}/-{1})', scorecard.insertions, scorecard.deletions);
    } else {
        diffSegment = l10n.t('{0} files (+{1}/-{2})', scorecard.filesChanged, scorecard.insertions, scorecard.deletions);
    }

    let mergeSegment: string;
    if (scorecard.hasConflicts) {
        mergeSegment = scorecard.conflictingFilesCount > 0
            ? l10n.t('⚠️ {0} conflicts', scorecard.conflictingFilesCount)
            : l10n.t('⚠️ Merge conflict');
    } else if (scorecard.hasUncommittedChanges) {
        mergeSegment = l10n.t('⚠️ {0} uncommitted', scorecard.uncommittedFilesCount);
    } else if (!scorecard.canMerge) {
        mergeSegment = l10n.t('⚠️ Cannot merge');
    } else {
        mergeSegment = l10n.t('✓ Clean merge');
    }

    const lspSegment = scorecard.lspErrorCount > 0
        ? l10n.t('🔴 {0} LSP errors', scorecard.lspErrorCount)
        : l10n.t('0 LSP errors');

    return `${diffSegment} • ${mergeSegment} • ${lspSegment}`;
}

/**
 * Formats a structured closed-loop prompt instructing the worktree agent to resolve merge blockers
 */
export function formatMergeConflictPrompt(
    branchName: string,
    targetBranch: string,
    verification: {
        conflictingFiles?: string[];
        uncommittedFiles?: string[];
        errorDetails?: string;
    }
): string {
    const lines: string[] = [
        `## ⚠️ Pre-Merge Verification Failed (\`${branchName}\` → \`${targetBranch}\`)`,
        '',
        `We attempted to merge worktree branch \`${branchName}\` into \`${targetBranch}\`, but pre-merge verification detected blockers:`
    ];

    if (verification.uncommittedFiles && verification.uncommittedFiles.length > 0) {
        lines.push('');
        lines.push(`### 1. Uncommitted Changes in Worktree (${verification.uncommittedFiles.length} file(s))`);
        lines.push('Please review, test, and commit (or clean up) the following uncommitted files in your worktree:');
        for (const f of verification.uncommittedFiles) {
            lines.push(`- \`${f}\``);
        }
    }

    if ((verification.conflictingFiles && verification.conflictingFiles.length > 0) || verification.errorDetails) {
        lines.push('');
        lines.push(`### 2. Merge Conflicts with \`${targetBranch}\``);
        if (verification.conflictingFiles && verification.conflictingFiles.length > 0) {
            lines.push('Conflicting files:');
            for (const f of verification.conflictingFiles) {
                lines.push(`- \`${f}\``);
            }
        }
        if (verification.errorDetails) {
            lines.push('');
            lines.push('Git Conflict Details:');
            lines.push(formatCodeFence(verification.errorDetails, 'text'));
        }
    }

    lines.push('');
    lines.push('### 🛠️ Required Action');
    lines.push(`1. Commit or stash any pending work on \`${branchName}\`.`);
    lines.push(`2. Merge or rebase \`${targetBranch}\` into \`${branchName}\` and resolve all conflicts cleanly.`);
    lines.push(`3. Run the test suite/build to verify there are no regressions, then commit the resolved state.`);

    return lines.join('\n');
}

/**
 * Resolves the destination directory for a new worktree
 */
export function resolveWorktreePath(
    repoRoot: string, 
    branchName: string, 
    locationPreference: 'sibling' | '.worktrees' = 'sibling'
): string {
    const repoBasename = path.basename(repoRoot);
    const slug = sanitizeBranchSlug(branchName);

    if (locationPreference === '.worktrees') {
        return path.join(repoRoot, '.worktrees', slug);
    }
    return path.join(path.dirname(repoRoot), `${repoBasename}-${slug}`);
}

/**
 * Validates that a workspace/worktree directory exists on disk and opens it in a VS Code window
 */
export async function openWorkspaceFolderInWindow(
    targetPath: string | undefined,
    forceNewWindow: boolean = true
): Promise<boolean> {
    if (!targetPath || !targetPath.trim()) {
        return false;
    }

    const resolvedPath = path.resolve(targetPath.trim());
    try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    if (vscode && vscode.commands && vscode.Uri) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(resolvedPath), { forceNewWindow });
        return true;
    }
    return false;
}

/**
 * Checks whether the selected agent's Herdr integration is installed and up to date,
 * offering a one-click install/update prompt if missing or outdated.
 */
export async function ensureAgentIntegrationReady(
    agent: AgentOptionItem,
    socketClient?: HerdrSocketClient,
    integrations?: ParsedIntegrationInfo[]
): Promise<'proceed' | 'cancel'> {
    if (!vscode || !agent.cmd) {
        return 'proceed';
    }

    const target = agent.integrationTarget || mapAgentCmdToIntegrationTarget(agent.cmd);
    if (!target) {
        return 'proceed';
    }

    const list = integrations ?? await fetchIntegrationStatuses(socketClient);
    const matched = list.find(i => i.cliTarget === target);
    if (!matched || matched.state === 'current') {
        return 'proceed';
    }

    const installOrUpdateBtn = matched.state === 'outdated'
        ? l10n.t('Update Integration & Launch')
        : l10n.t('Install Integration & Launch');
    const continueBtn = l10n.t('Launch Without Integration');
    const cancelBtn = l10n.t('Cancel');

    const msg = matched.state === 'outdated'
        ? l10n.t("Herdr integration for '{0}' is outdated ({1}). Update it now for reliable agent detection?", target, matched.details || 'legacy')
        : l10n.t("Herdr integration for '{0}' is not installed. Install it now for automatic status tracking and prompt delivery?", target);

    const choice = await vscode.window.showWarningMessage(
        msg,
        installOrUpdateBtn,
        continueBtn,
        cancelBtn
    );

    if (!choice || choice === cancelBtn) {
        return 'cancel';
    }

    if (choice === installOrUpdateBtn) {
        const ok = await installHerdrIntegration(target, socketClient);
        if (ok) {
            vscode.window.showInformationMessage(l10n.t("Herdr integration for '{0}' installed/updated.", target));
        } else {
            vscode.window.showWarningMessage(l10n.t("Failed to install integration for '{0}'. Proceeding with launch.", target));
        }
    }

    return 'proceed';
}

export interface StartAgentInPaneOptions {
    sessionName: string;
    paneId: string;
    agentName: string;
    agentCmd: string;
    agentKind?: string;
    prompt?: string;
    cwd?: string;
    socketClient?: HerdrSocketClient;
}

export interface StartAgentInPaneResult {
    method: 'native' | 'fallback';
    started: boolean;
    prompted: boolean;
}

/**
 * Starts an interactive agent in an existing Herdr pane.
 * Uses native `agent.start` + `agent.prompt` when `agentKind` is known, falling back
 * to `pane.send_input` / `pane send-text` for custom commands or older Herdr servers.
 */
export async function startAgentInPane(options: StartAgentInPaneOptions): Promise<StartAgentInPaneResult> {
    const { sessionName, paneId, agentName, agentCmd, agentKind, prompt, cwd, socketClient } = options;
    const trimmedPrompt = prompt ? prompt.trim() : '';

    if (agentKind) {
        let nativeStarted = false;

        if (socketClient && socketClient.isConnected) {
            try {
                await socketClient.startAgent({
                    name: agentName,
                    kind: agentKind,
                    paneId,
                    timeoutMs: 30000
                });
                nativeStarted = true;
            } catch {
                nativeStarted = false;
            }
        }

        if (!nativeStarted) {
            nativeStarted = await new Promise<boolean>((resolve) => {
                execHerdr(
                    ['--session', sessionName, 'agent', 'start', agentName, '--kind', agentKind, '--pane', paneId, '--timeout', '30000'],
                    { cwd },
                    (err: any) => resolve(!err)
                );
            });
        }

        if (nativeStarted) {
            let prompted = false;
            if (trimmedPrompt) {
                if (socketClient && socketClient.isConnected) {
                    try {
                        await socketClient.sendAgentPrompt(agentName, trimmedPrompt);
                        prompted = true;
                    } catch {
                        prompted = false;
                    }
                }
                if (!prompted) {
                    prompted = await new Promise<boolean>((resolve) => {
                        execHerdr(
                            ['--session', sessionName, 'agent', 'prompt', agentName, trimmedPrompt],
                            { cwd },
                            (err: any) => resolve(!err)
                        );
                    });
                }
            }
            return { method: 'native', started: true, prompted };
        }
    }

    // Fallback: shell command execution via pane input
    const launchCmd = buildAgentLaunchCommand(agentCmd, trimmedPrompt || undefined);
    if (!launchCmd) {
        return { method: 'fallback', started: false, prompted: false };
    }

    if (socketClient && socketClient.isConnected) {
        try {
            await socketClient.sendPaneInput(paneId, launchCmd, ['enter']);
            return { method: 'fallback', started: true, prompted: Boolean(trimmedPrompt) };
        } catch {
            // Fall back to CLI
        }
    }

    const fallbackOk = await new Promise<boolean>((resolve) => {
        execHerdr(['--session', sessionName, 'pane', 'send-text', paneId, `${launchCmd}\n`], { cwd }, (err: any) => {
            resolve(!err);
        });
    });
    return { method: 'fallback', started: fallbackOk, prompted: fallbackOk && Boolean(trimmedPrompt) };
}

export interface CreateHerdrWorkspaceOptions {
    sessionName: string;
    cwd: string;
    label?: string;
    focus?: boolean;
    socketClient?: HerdrSocketClient;
}

export interface CreateHerdrWorkspaceResult {
    workspaceId: string;
    tabId?: string;
    rootPaneId: string;
}

/**
 * Collects currently active lowercase agent names from a connected Herdr socket snapshot.
 */
export async function collectExistingAgentNames(socketClient?: HerdrSocketClient): Promise<Set<string>> {
    const names = new Set<string>();
    if (!socketClient || !socketClient.isConnected) {
        return names;
    }
    try {
        const snap = await socketClient.getSnapshot();
        if (snap) {
            for (const ag of parseSnapshotAgents(snap)) {
                if (ag.name) {
                    names.add(ag.name.toLowerCase());
                }
            }
        }
    } catch {
        // Ignore snapshot failures
    }
    return names;
}

/**
 * Creates a Herdr workspace (preferring native socket `workspace.create` with CLI fallback)
 * and resolves the resulting workspace ID and initial root pane ID.
 */
export async function createHerdrWorkspace(options: CreateHerdrWorkspaceOptions): Promise<CreateHerdrWorkspaceResult> {
    const { sessionName, cwd, label, focus = false, socketClient } = options;
    let workspaceId = '';
    let tabId = '';
    let rootPaneId = '';

    const extractIds = (raw: any) => {
        const res = raw?.result || raw;
        if (res?.workspace?.workspace_id) workspaceId = String(res.workspace.workspace_id);
        if (res?.tab?.tab_id) tabId = String(res.tab.tab_id);
        if (res?.root_pane?.pane_id) rootPaneId = String(res.root_pane.pane_id);
    };

    if (socketClient && socketClient.isConnected) {
        try {
            const res = await socketClient.createWorkspace({ cwd, label, focus });
            extractIds(res);
        } catch {
            // Fall back to CLI
        }
    }

    if (!workspaceId && !rootPaneId) {
        const createArgs = ['--session', sessionName, 'workspace', 'create', '--cwd', cwd];
        if (label) {
            createArgs.push('--label', label);
        }
        createArgs.push(focus ? '--focus' : '--no-focus');

        await new Promise<void>((resolve, reject) => {
            execHerdr(createArgs, (err: any, stdout: string) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    extractIds(JSON.parse(stdout));
                } catch {}
                resolve();
            });
        });
    }

    if (!rootPaneId) {
        try {
            const [rawWorkspaces, rawPanes] = await Promise.all([
                new Promise<string>((resolve) => {
                    execHerdr(['--session', sessionName, 'workspace', 'list'], (_err: any, stdout: string) => resolve(stdout || ''));
                }),
                new Promise<string>((resolve) => {
                    execHerdr(['--session', sessionName, 'pane', 'list'], (_err: any, stdout: string) => resolve(stdout || ''));
                })
            ]);

            const parsedPanes = parsePanes(rawPanes);
            const parsedWorkspaces = parseWorkspaces(rawWorkspaces, parsedPanes);

            const matchedWorkspace = parsedWorkspaces.find(ws =>
                (workspaceId && ws.id === workspaceId)
                || (label && ws.label === label)
                || (ws.cwd && path.resolve(ws.cwd) === path.resolve(cwd))
            );

            if (matchedWorkspace) {
                workspaceId = matchedWorkspace.id;
                const matchedPane = parsedPanes.find(p => p.workspaceId === matchedWorkspace.id);
                if (matchedPane) {
                    rootPaneId = matchedPane.id;
                }
            }
        } catch (e) {
            console.error('[herdr-collie] Error finding created workspace pane:', e);
        }
    }

    return {
        workspaceId,
        ...(tabId ? { tabId } : {}),
        rootPaneId
    };
}

export interface SplitHerdrPaneOptions {
    sessionName: string;
    direction: 'right' | 'down';
    targetPaneId?: string;
    workspaceId?: string;
    cwd?: string;
    ratio?: number;
    focus?: boolean;
    socketClient?: HerdrSocketClient;
}

/**
 * Splits an existing Herdr pane (preferring native socket `pane.split` with CLI fallback)
 * and returns the newly created pane ID.
 */
export async function splitHerdrPane(options: SplitHerdrPaneOptions): Promise<string> {
    const { sessionName, direction, targetPaneId, workspaceId, cwd, ratio, focus = false, socketClient } = options;

    const extractPaneId = (raw: any): string => {
        const res = raw?.result || raw;
        if (res?.pane?.pane_id) return String(res.pane.pane_id);
        if (res?.pane_id) return String(res.pane_id);
        return '';
    };

    if (socketClient && socketClient.isConnected) {
        try {
            const res = await socketClient.splitPane({
                direction,
                targetPaneId,
                workspaceId,
                cwd,
                ratio,
                focus
            });
            const paneId = extractPaneId(res);
            if (paneId) {
                return paneId;
            }
        } catch {
            // Fall back to CLI
        }
    }

    const args = ['--session', sessionName, 'pane', 'split', '--direction', direction];
    if (targetPaneId) {
        args.push('--pane', targetPaneId);
    }
    if (cwd) {
        args.push('--cwd', cwd);
    }
    if (ratio !== undefined) {
        args.push('--ratio', String(ratio));
    }
    args.push(focus ? '--focus' : '--no-focus');

    return await new Promise<string>((resolve, reject) => {
        execHerdr(args, { cwd }, (err: any, stdout: string) => {
            if (err) {
                reject(err);
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve(extractPaneId(parsed));
            } catch {
                resolve('');
            }
        });
    });
}

/**
 * Interactive QuickPick manager for diagnosing, installing, updating, and uninstalling Herdr agent integrations.
 */
export async function manageIntegrationsWizard(socketClient?: HerdrSocketClient): Promise<void> {
    if (!vscode) return;

    const integrations = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: l10n.t('Checking Herdr agent integrations...'),
            cancellable: false
        },
        async () => await fetchIntegrationStatuses(socketClient)
    );

    if (integrations.length === 0) {
        vscode.window.showWarningMessage(l10n.t('Could not retrieve Herdr integration status. Ensure `herdr` CLI is installed.'));
        return;
    }

    interface IntegrationPickItem extends vscodeTypes.QuickPickItem {
        action: 'updateAll' | 'installAvailable' | 'toggle';
        integration?: ParsedIntegrationInfo;
    }

    const outdatedItems = integrations.filter(i => i.state === 'outdated');
    const missingAvailableItems = integrations.filter(i => i.state === 'not_installed' && i.available);
    const items: IntegrationPickItem[] = [];

    if (outdatedItems.length > 0) {
        items.push({
            label: `$(sync) ` + l10n.t('Update All Outdated Integrations ({0})', outdatedItems.length),
            description: outdatedItems.map(i => i.cliTarget).join(', '),
            detail: l10n.t('Re-installs legacy Herdr hooks to match the current Herdr version'),
            action: 'updateAll'
        });
    }

    if (missingAvailableItems.length > 0) {
        items.push({
            label: `$(cloud-download) ` + l10n.t('Install Integrations for Detected CLIs ({0})', missingAvailableItems.length),
            description: missingAvailableItems.map(i => i.cliTarget).join(', '),
            detail: l10n.t('Installs Herdr hooks for installed agent CLIs'),
            action: 'installAvailable'
        });
    }

    const sorted = [...integrations].sort((a, b) => {
        const order: Record<string, number> = { outdated: 0, not_installed: 1, current: 2 };
        const diff = (order[a.state] ?? 3) - (order[b.state] ?? 3);
        return diff !== 0 ? diff : a.cliTarget.localeCompare(b.cliTarget);
    });

    for (const info of sorted) {
        const icon = info.state === 'current' ? '$(check)' : (info.state === 'outdated' ? '$(warning)' : '$(circle-outline)');
        const stateLabel = info.state === 'current'
            ? l10n.t('Installed (Current)')
            : (info.state === 'outdated' ? l10n.t('Outdated') : l10n.t('Not Installed'));
        const detailParts = [info.details, info.path].filter(Boolean);
        items.push({
            label: `${icon} ${info.cliTarget}`,
            description: stateLabel + (info.experimental ? ' (experimental)' : ''),
            detail: detailParts.join(' — ') || undefined,
            action: 'toggle',
            integration: info
        });
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: l10n.t('Manage Herdr Agent Integrations'),
        placeHolder: l10n.t('Select an integration to install, update, or uninstall')
    });

    if (!picked) return;

    if (picked.action === 'updateAll') {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: l10n.t('Updating {0} outdated Herdr integration(s)...', outdatedItems.length),
                cancellable: false
            },
            async () => {
                let updated = 0;
                for (const item of outdatedItems) {
                    if (await installHerdrIntegration(item.cliTarget, socketClient)) {
                        updated++;
                    }
                }
                vscode.window.showInformationMessage(l10n.t('Updated {0}/{1} Herdr integration(s).', updated, outdatedItems.length));
            }
        );
        return;
    }

    if (picked.action === 'installAvailable') {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: l10n.t('Installing {0} Herdr integration(s)...', missingAvailableItems.length),
                cancellable: false
            },
            async () => {
                let installed = 0;
                for (const item of missingAvailableItems) {
                    if (await installHerdrIntegration(item.cliTarget, socketClient)) {
                        installed++;
                    }
                }
                vscode.window.showInformationMessage(l10n.t('Installed {0}/{1} Herdr integration(s).', installed, missingAvailableItems.length));
            }
        );
        return;
    }

    if (picked.action === 'toggle' && picked.integration) {
        const target = picked.integration.cliTarget;
        if (picked.integration.state === 'current') {
            const uninstallBtn = l10n.t('Uninstall');
            const reinstallBtn = l10n.t('Reinstall');
            const choice = await vscode.window.showInformationMessage(
                l10n.t("Integration '{0}' is up to date.", target),
                reinstallBtn,
                uninstallBtn
            );
            if (choice === reinstallBtn) {
                const ok = await installHerdrIntegration(target, socketClient);
                if (ok) {
                    vscode.window.showInformationMessage(l10n.t("Herdr integration for '{0}' installed/updated.", target));
                } else {
                    vscode.window.showErrorMessage(l10n.t("Failed to install integration for '{0}'.", target));
                }
            } else if (choice === uninstallBtn) {
                const ok = await uninstallHerdrIntegration(target, socketClient);
                if (ok) {
                    vscode.window.showInformationMessage(l10n.t("Herdr integration for '{0}' uninstalled.", target));
                } else {
                    vscode.window.showErrorMessage(l10n.t("Failed to uninstall integration for '{0}'.", target));
                }
            }
        } else {
            const ok = await installHerdrIntegration(target, socketClient);
            if (ok) {
                vscode.window.showInformationMessage(l10n.t("Herdr integration for '{0}' installed/updated.", target));
            } else {
                vscode.window.showErrorMessage(l10n.t("Failed to install integration for '{0}'.", target));
            }
        }
    }
}

/**
 * Formats a structured prompt asking the worktree agent to commit, push, and create a Pull Request via `gh`.
 */
export function formatCreatePullRequestPrompt(
    branchName: string,
    baseBranch: string,
    customInstruction?: string
): string {
    const lines: string[] = [
        `## 🚀 Create Pull Request (\`${branchName}\` → \`${baseBranch}\`)`,
        '',
        `Please finalize your changes on worktree branch \`${branchName}\` and open a Pull Request against \`${baseBranch}\`:`,
        '',
        '1. Review `git status` and `git diff` to ensure no unintended or temporary files remain.',
        '2. Run the project build/test suite to confirm everything passes.',
        '3. If there are uncommitted changes, stage and commit them with a clear conventional commit message.',
        `4. Push \`${branchName}\` to \`origin\` (\`git push -u origin ${branchName}\`).`,
        `5. Create a Pull Request using \`gh pr create --base ${baseBranch}\` with a concise summary title and bullet-point body describing the changes and test results.`
    ];

    if (customInstruction && customInstruction.trim()) {
        lines.push('');
        lines.push('**Additional Instructions:**');
        lines.push(customInstruction.trim());
    }

    return lines.join('\n');
}

/**
 * Pushes a worktree branch to origin and creates a Pull Request using GitHub CLI (`gh`).
 */
export async function pushAndCreatePullRequestWithGh(
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    title: string,
    body?: string
): Promise<string> {
    const branchErr = validateBranchName(branchName);
    if (branchErr) {
        throw new Error(branchErr);
    }
    const baseErr = validateBranchName(baseBranch);
    if (baseErr) {
        throw new Error(baseErr);
    }

    await runGitCmd(['push', '-u', 'origin', branchName], worktreePath);

    const ghArgs = ['pr', 'create', '--base', baseBranch, '--head', branchName, '--title', title];
    if (body && body.trim()) {
        ghArgs.push('--body', body.trim());
    } else {
        ghArgs.push('--fill');
    }

    return await new Promise<string>((resolve, reject) => {
        cp.execFile('gh', ghArgs, { cwd: worktreePath }, (error: any, stdout: string, stderr: string) => {
            if (error) {
                const msg = (stderr && stderr.trim()) || (stdout && stdout.trim()) || error.message || 'gh pr create failed';
                reject(new Error(msg));
                return;
            }
            resolve((stdout || '').trim());
        });
    });
}

/**
 * Parses `gh issue list --json number,title,body,labels,url` output safely.
 */
export function parseGitHubIssuesJson(rawJson: string): GitHubIssueSummary[] {
    if (!rawJson || !rawJson.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(rawJson);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const issues: GitHubIssueSummary[] = [];
        for (const item of parsed) {
            if (!item || typeof item.number !== 'number' || typeof item.title !== 'string') {
                continue;
            }
            const labels = Array.isArray(item.labels)
                ? item.labels
                    .map((l: any) => (typeof l === 'string' ? l : (l && typeof l.name === 'string' ? l.name : '')))
                    .filter(Boolean)
                : [];
            issues.push({
                number: item.number,
                title: item.title,
                body: typeof item.body === 'string' ? item.body : undefined,
                url: typeof item.url === 'string' ? item.url : undefined,
                labels
            });
        }
        return issues;
    } catch {
        return [];
    }
}

/**
 * Suggests a valid, concise Git branch name from a GitHub issue (e.g. `issue-42-fix-oauth`).
 */
export function suggestBranchNameFromIssue(issue: Pick<GitHubIssueSummary, 'number' | 'title'>): string {
    const asciiSlug = (issue.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
    const candidate = asciiSlug ? `issue-${issue.number}-${asciiSlug}` : `issue-${issue.number}`;
    return validateBranchName(candidate) === null ? candidate : `issue-${issue.number}`;
}

/**
 * Fetches open GitHub issues via `gh issue list` without shell interpolation.
 * Returns an empty list if `gh` is unavailable, unauthenticated, or the repo has no GitHub remote.
 */
export async function fetchOpenGitHubIssues(repoRoot: string, limit: number = 25): Promise<GitHubIssueSummary[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return await new Promise<GitHubIssueSummary[]>((resolve) => {
        cp.execFile(
            'gh',
            ['issue', 'list', '--state', 'open', '--limit', String(safeLimit), '--json', 'number,title,body,labels,url'],
            { cwd: repoRoot, timeout: 8000, maxBuffer: 5 * 1024 * 1024 },
            (error: any, stdout: string) => {
                if (error || !stdout) {
                    resolve([]);
                    return;
                }
                resolve(parseGitHubIssuesJson(stdout));
            }
        );
    });
}

const FAILING_PR_CHECK_STATES = /^(fail|failure|error|timed_out|action_required|startup_failure|cancelled)$/i;

/**
 * Parses `gh pr checks --json name,state,link,description` output and filters failing checks.
 */
export function parseFailingPrChecksJson(rawJson: string): FailingPrCheckSummary[] {
    if (!rawJson || !rawJson.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(rawJson);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const failing: FailingPrCheckSummary[] = [];
        for (const item of parsed) {
            if (!item || typeof item.name !== 'string') {
                continue;
            }
            const state = typeof item.state === 'string' ? item.state : '';
            const bucket = typeof item.bucket === 'string' ? item.bucket : '';
            if (!FAILING_PR_CHECK_STATES.test(state.trim()) && bucket.toLowerCase() !== 'fail') {
                continue;
            }
            failing.push({
                name: item.name,
                state: state || 'FAIL',
                link: typeof item.link === 'string' ? item.link : undefined,
                description: typeof item.description === 'string' ? item.description : undefined
            });
        }
        return failing;
    } catch {
        return [];
    }
}

/**
 * Extracts a numeric GitHub Actions workflow run ID from a check link URL if present.
 */
export function extractGitHubRunIdFromUrl(link?: string): string | null {
    if (!link) return null;
    const match = link.match(/\/actions\/runs\/(\d+)/i);
    return match && /^\d+$/.test(match[1]) ? match[1] : null;
}

/**
 * Fetches failing Pull Request CI checks (and failed workflow log tail when available) via `gh`.
 */
export async function fetchFailingPrChecksWithLogs(
    worktreePath: string,
    branchName: string
): Promise<{ checks: FailingPrCheckSummary[]; logSnippet?: string; prError?: string }> {
    const branchErr = validateBranchName(branchName);
    if (branchErr) {
        return { checks: [], prError: branchErr };
    }

    const runPrChecks = (jsonFields: string): Promise<{ checks: FailingPrCheckSummary[]; prError?: string; unknownField?: boolean }> =>
        new Promise((resolve) => {
            cp.execFile(
                'gh',
                ['pr', 'checks', branchName, '--json', jsonFields],
                { cwd: worktreePath, timeout: 8000, maxBuffer: 5 * 1024 * 1024 },
                (error: any, stdout: string, stderr: string) => {
                    // `gh pr checks` may exit non-zero when checks are failing even if JSON stdout is valid
                    if (stdout && stdout.trim().startsWith('[')) {
                        resolve({ checks: parseFailingPrChecksJson(stdout) });
                        return;
                    }
                    if (error) {
                        const msg = (stderr && stderr.trim()) || (stdout && stdout.trim()) || error.message || 'gh pr checks failed';
                        resolve({
                            checks: [],
                            prError: msg,
                            unknownField: /unknown\s+json\s+field/i.test(msg)
                        });
                        return;
                    }
                    resolve({ checks: parseFailingPrChecksJson(stdout || '') });
                }
            );
        });

    let checksResult = await runPrChecks('name,state,bucket,link,description');
    if (checksResult.unknownField) {
        checksResult = await runPrChecks('name,state,link,description');
    }

    if (checksResult.prError || checksResult.checks.length === 0) {
        return { checks: checksResult.checks, ...(checksResult.prError ? { prError: checksResult.prError } : {}) };
    }

    const firstRunId = checksResult.checks
        .map(c => extractGitHubRunIdFromUrl(c.link))
        .find((id): id is string => Boolean(id));

    if (!firstRunId) {
        return { checks: checksResult.checks };
    }

    const logSnippet = await new Promise<string | undefined>((resolve) => {
        cp.execFile(
            'gh',
            ['run', 'view', firstRunId, '--log-failed'],
            { cwd: worktreePath, timeout: 8000, maxBuffer: 5 * 1024 * 1024 },
            (error: any, stdout: string) => {
                if (error || !stdout || !stdout.trim()) {
                    resolve(undefined);
                    return;
                }
                const cleaned = stripTerminalControlSequences(stdout);
                if (!cleaned) {
                    resolve(undefined);
                    return;
                }
                resolve(cleaned.length > 6000 ? cleaned.slice(cleaned.length - 6000) : cleaned);
            }
        );
    });

    return { checks: checksResult.checks, logSnippet };
}

/**
 * Full interactive wizard for launching an AI agent inside an isolated Git Worktree
 */
export async function launchWorktreeAgentWizard(
    sessionName: string,
    onSuccess?: () => void,
    socketClient?: HerdrSocketClient
): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(l10n.t('Please open a folder inside a Git repository first.'));
        return;
    }

    const activeDocPath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
    let repoRoot: string | null = activeDocPath ? await getRepoRoot(path.dirname(activeDocPath)) : null;
    if (!repoRoot) {
        for (const folder of workspaceFolders) {
            repoRoot = await getRepoRoot(folder.uri.fsPath);
            if (repoRoot) break;
        }
    }
    if (!repoRoot) {
        vscode.window.showErrorMessage(l10n.t('The current workspace is not a Git repository.'));
        return;
    }

    // 1. Optional GitHub Issue source selection + Branch name input
    let selectedIssue: GitHubIssueSummary | undefined;
    let suggestedBranch = '';
    const ghAvailable = await isCommandAvailable('gh');

    if (ghAvailable) {
        const sourcePick = await vscode.window.showQuickPick(
            [
                {
                    label: `$(git-branch) ${l10n.t('Enter Branch Name Manually')}`,
                    detail: l10n.t('Type a new or existing Git branch name'),
                    source: 'manual' as const
                },
                {
                    label: `$(issues) ${l10n.t('Create from GitHub Issue...')}`,
                    detail: l10n.t('Fetch open issues via GitHub CLI (gh) and pre-fill task context'),
                    source: 'issue' as const
                }
            ],
            {
                title: l10n.t('Herdr Swarm: Worktree Source'),
                placeHolder: l10n.t('Choose how to name and initialize the new worktree')
            }
        );
        if (!sourcePick) return;

        if (sourcePick.source === 'issue') {
            const issues = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: l10n.t('Fetching open GitHub issues...')
                },
                async () => await fetchOpenGitHubIssues(repoRoot)
            );
            if (issues.length === 0) {
                vscode.window.showInformationMessage(
                    l10n.t('No open GitHub issues found (or gh is not authenticated). Entering branch name manually.')
                );
            } else {
                const pickedIssue = await vscode.window.showQuickPick(
                    issues.map(issue => ({
                        label: `#${issue.number} ${issue.title}`,
                        description: issue.labels && issue.labels.length > 0 ? issue.labels.join(', ') : undefined,
                        detail: issue.body ? issue.body.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : issue.url,
                        issue
                    })),
                    {
                        title: l10n.t('Herdr Swarm: Select GitHub Issue'),
                        placeHolder: l10n.t('Choose an open issue to pre-fill branch name and agent prompt')
                    }
                );
                if (!pickedIssue) return;
                selectedIssue = pickedIssue.issue;
                suggestedBranch = suggestBranchNameFromIssue(selectedIssue);
            }
        }
    }

    const branchName = await vscode.window.showInputBox({
        title: l10n.t('Herdr Swarm: Branch Name'),
        prompt: l10n.t('Enter a branch name for the new agent worktree'),
        placeHolder: l10n.t('e.g. feat/user-auth, fix/issue-42'),
        value: suggestedBranch,
        validateInput: validateBranchName
    });

    if (!branchName) return;

    // 2. Base branch selection
    const branches = await listGitBranches(repoRoot);
    const currentBranch = await getCurrentGitBranch(repoRoot);
    
    // Sort so current branch and main/master are on top
    const sortedBranches = Array.from(new Set([currentBranch, 'main', 'master', ...branches])).filter(b => branches.includes(b));
    
    const baseBranchItems = sortedBranches.map(b => ({
        label: `$(git-branch) ${b}`,
        description: b === currentBranch ? l10n.t('(current branch)') : '',
        branchName: b
    }));

    const selectedBase = await vscode.window.showQuickPick(baseBranchItems, {
        title: l10n.t('Herdr Swarm: Base Branch'),
        placeHolder: l10n.t('Select base branch to branch from (default: {0})', currentBranch)
    });

    if (!selectedBase) return;

    // 3. Agent CLI selection + Integration health check
    const config = vscode.workspace.getConfiguration('herdr-collie');
    const defaultAgent = config.get<string>('defaultAgentCommand', 'claude');

    const integrations = await fetchIntegrationStatuses(socketClient).catch(() => [] as ParsedIntegrationInfo[]);
    const agentOptions = await getInstalledAgentOptions(socketClient, integrations);

    let chosenAgentCmd = defaultAgent;
    let chosenAgentKind: string | undefined;
    const selectedAgent = await vscode.window.showQuickPick(agentOptions, {
        title: l10n.t('Herdr Swarm: AI Agent Engine'),
        placeHolder: l10n.t('Select AI Agent tool to launch in the worktree workspace')
    });

    if (!selectedAgent) return;

    if (selectedAgent.cmd === 'CUSTOM') {
        const customCmd = await vscode.window.showInputBox({
            title: l10n.t('Custom Agent Command'),
            prompt: l10n.t('Enter command to run inside the worktree workspace'),
            placeHolder: l10n.t('e.g. claude --dangerously-skip-permissions')
        });
        if (!customCmd) return;
        chosenAgentCmd = customCmd;
    } else {
        chosenAgentCmd = selectedAgent.cmd;
        chosenAgentKind = selectedAgent.agentKind;
        if (chosenAgentCmd) {
            const ready = await ensureAgentIntegrationReady(selectedAgent, socketClient, integrations);
            if (ready === 'cancel') return;
        }
    }

    // 4. Initial Task / Prompt input
    let prompt: string | undefined;
    if (selectedIssue) {
        const extraInstruction = await vscode.window.showInputBox({
            title: l10n.t('Herdr Swarm: Initial Task Prompt (Optional)'),
            prompt: l10n.t('Additional instructions for Issue #{0} (Optional)', selectedIssue.number),
            placeHolder: l10n.t('e.g. Focus on backward compatibility and add regression tests')
        });
        if (extraInstruction === undefined) return;
        prompt = formatGitHubIssueTaskPrompt(selectedIssue, extraInstruction.trim() || undefined);
    } else {
        prompt = await vscode.window.showInputBox({
            title: l10n.t('Herdr Swarm: Initial Task Prompt (Optional)'),
            prompt: l10n.t('Enter initial instructions or task description for the agent'),
            placeHolder: l10n.t('e.g. Implement OAuth2 Google login flow and write unit tests')
        });
    }

    // 5. Worktree Location resolution
    const locationPref = config.get<'sibling' | '.worktrees'>('worktreeLocation', 'sibling');
    const worktreePath = resolveWorktreePath(repoRoot, branchName, locationPref);

    // Create parent directory if .worktrees
    if (locationPref === '.worktrees') {
        const worktreesDir = path.join(repoRoot, '.worktrees');
        if (!fs.existsSync(worktreesDir)) {
            fs.mkdirSync(worktreesDir, { recursive: true });
        }
    }

    // 6. Execute Provisioning with progress notification
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: l10n.t("Spawning Herdr Swarm Agent on '{0}'...", branchName),
        cancellable: false
    }, async (progress) => {
        progress.report({ message: l10n.t('Creating Git Worktree...') });
        try {
            await createWorktree(repoRoot, branchName, worktreePath, selectedBase.branchName);
        } catch (err: any) {
            vscode.window.showErrorMessage(l10n.t('Failed to create Git Worktree: {0}', err.message || err));
            return;
        }

        const bootstrapOpts = getWorktreeBootstrapOptions();
        if ((bootstrapOpts.copyFiles && bootstrapOpts.copyFiles.length > 0) || bootstrapOpts.postCreateCommand) {
            progress.report({ message: l10n.t('Bootstrapping worktree environment...') });
            const bootRes = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, bootstrapOpts);
            if (bootRes.warnings.length > 0) {
                vscode.window.showWarningMessage(
                    l10n.t('Worktree created with setup warnings: {0}', bootRes.warnings.join('; '))
                );
            }
        }

        progress.report({ message: l10n.t('Creating Herdr Workspace...') });
        const existingAgentNames = await collectExistingAgentNames(socketClient);
        let targetWorkspaceId = '';
        let targetPaneId = '';

        try {
            const wsResult = await createHerdrWorkspace({
                sessionName,
                cwd: worktreePath,
                label: branchName,
                focus: false,
                socketClient
            });
            targetWorkspaceId = wsResult.workspaceId;
            targetPaneId = wsResult.rootPaneId;
        } catch (err: any) {
            vscode.window.showErrorMessage(l10n.t('Failed to create Herdr Workspace: {0}', err.message || err));
            return;
        }

        // Spawn agent if agent command specified
        if (chosenAgentCmd) {
            progress.report({ message: l10n.t('Starting Agent ({0})...', chosenAgentCmd) });
            if (targetPaneId) {
                const agentName = sanitizeAgentName(branchName, existingAgentNames);
                await startAgentInPane({
                    sessionName,
                    paneId: targetPaneId,
                    agentName,
                    agentCmd: chosenAgentCmd,
                    agentKind: chosenAgentKind,
                    prompt,
                    cwd: worktreePath,
                    socketClient
                });
            } else {
                vscode.window.showWarningMessage(l10n.t("Workspace '{0}' was created, but initial pane could not be determined. Please start the agent manually in the terminal.", branchName));
            }
        }

        if (onSuccess) {
            onSuccess();
        }

        // Show completed notification with actions
        const openWindowBtn = l10n.t('Open in VS Code Window');
        const attachTerminalBtn = l10n.t('Attach Terminal');
        const action = await vscode.window.showInformationMessage(
            l10n.t("🚀 Agent launched in worktree '{0}' ({1})", branchName, worktreePath),
            openWindowBtn,
            attachTerminalBtn
        );

        if (action === openWindowBtn) {
            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), { forceNewWindow: true });
        } else if (action === attachTerminalBtn) {
            vscode.commands.executeCommand('herdr-collie.attachWorkspace', targetWorkspaceId || branchName, false, branchName, sessionName);
        }
    });
}
