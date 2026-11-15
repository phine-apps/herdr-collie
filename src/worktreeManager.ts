/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import type * as vscodeTypes from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { runGitCmd, execHerdr, isCommandAvailable } from './executors';
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
import { formatCodeFence } from './formatters';

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

    const currentCwd = workspaceFolders[0].uri.fsPath;
    const repoRoot = await getRepoRoot(currentCwd);
    if (!repoRoot) {
        vscode.window.showErrorMessage(l10n.t('The current workspace is not a Git repository.'));
        return;
    }

    // 1. Branch name input
    const branchName = await vscode.window.showInputBox({
        title: l10n.t('Herdr Swarm: Branch Name'),
        prompt: l10n.t('Enter a branch name for the new agent worktree'),
        placeHolder: l10n.t('e.g. feat/user-auth, fix/issue-42'),
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
    const prompt = await vscode.window.showInputBox({
        title: l10n.t('Herdr Swarm: Initial Task Prompt (Optional)'),
        prompt: l10n.t('Enter initial instructions or task description for the agent'),
        placeHolder: l10n.t('e.g. Implement OAuth2 Google login flow and write unit tests')
    });

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
