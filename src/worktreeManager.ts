/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import type * as vscodeTypes from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import * as fs from 'fs';
import { runGitCmd, execHerdr, isCommandAvailable } from './executors';
import { parseGitWorktrees, GitWorktreeInfo, parsePanes, parseWorkspaces } from './parsers';
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
    cmd: string;
    checkCmd?: { binary: string; args?: string[] };
}

export const SUPPORTED_AGENT_DEFINITIONS: AgentOptionItem[] = [
    { label: '$(hubot) Claude Code', description: 'claude', cmd: 'claude', checkCmd: { binary: 'claude' } },
    { label: '$(hubot) Antigravity CLI', description: 'agy', cmd: 'agy', checkCmd: { binary: 'agy' } },
    { label: '$(hubot) Cursor Agent', description: 'cursor-agent', cmd: 'cursor-agent', checkCmd: { binary: 'cursor-agent' } },
    { label: '$(hubot) GitHub Copilot CLI', description: 'gh copilot', cmd: 'gh copilot', checkCmd: { binary: 'gh', args: ['copilot', '--help'] } },
    { label: '$(hubot) Codex CLI', description: 'codex', cmd: 'codex', checkCmd: { binary: 'codex' } },
    { label: '$(hubot) Gemini CLI', description: 'gemini', cmd: 'gemini', checkCmd: { binary: 'gemini' } },
    { label: '$(hubot) OpenCode CLI', description: 'opencode', cmd: 'opencode', checkCmd: { binary: 'opencode' } },
    { label: '$(hubot) Kilo CLI', description: 'kilo', cmd: 'kilo', checkCmd: { binary: 'kilo' } },
    { label: '$(hubot) Devin CLI', description: 'devin', cmd: 'devin', checkCmd: { binary: 'devin' } },
];

/**
 * Returns list of agent options filtered to only those installed on the user machine
 */
export async function getInstalledAgentOptions(): Promise<AgentOptionItem[]> {
    const checks = await Promise.all(
        SUPPORTED_AGENT_DEFINITIONS.map(async (agent) => {
            if (!agent.checkCmd) return { agent, installed: true };
            const installed = await isCommandAvailable(agent.checkCmd.binary, agent.checkCmd.args);
            return { agent, installed };
        })
    );

    const installedAgents = checks.filter(c => c.installed).map(c => c.agent);

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
 * Full interactive wizard for launching an AI agent inside an isolated Git Worktree
 */
export async function launchWorktreeAgentWizard(
    sessionName: string,
    onSuccess?: () => void
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

    // 3. Agent CLI selection
    const config = vscode.workspace.getConfiguration('herdr-collie');
    const defaultAgent = config.get<string>('defaultAgentCommand', 'claude');

    const agentOptions = await getInstalledAgentOptions();

    let chosenAgentCmd = defaultAgent;
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
        try {
            await new Promise<void>((resolve, reject) => {
                const createArgs = ['--session', sessionName, 'workspace', 'create', '--cwd', worktreePath, '--label', branchName];
                execHerdr(createArgs, (err: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(l10n.t('Failed to create Herdr Workspace: {0}', err.message || err));
            return;
        }

        // Resolve the newly created workspace and its initial pane
        let targetWorkspaceId = '';
        let targetPaneId = '';
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
                ws.label === branchName || (ws.cwd && path.resolve(ws.cwd) === path.resolve(worktreePath))
            );

            if (matchedWorkspace) {
                targetWorkspaceId = matchedWorkspace.id;
                const matchedPane = parsedPanes.find(p => p.workspaceId === matchedWorkspace.id);
                if (matchedPane) {
                    targetPaneId = matchedPane.id;
                }
            }
        } catch (e) {
            console.error('[herdr-collie] Error finding created workspace pane:', e);
        }

        // Spawn agent if agent command specified
        if (chosenAgentCmd) {
            const launchCmd = buildAgentLaunchCommand(chosenAgentCmd, prompt);
            progress.report({ message: l10n.t('Starting Agent ({0})...', chosenAgentCmd) });
            if (targetPaneId) {
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', sessionName, 'pane', 'send-text', targetPaneId, `${launchCmd}\n`], { cwd: worktreePath }, (err: any) => {
                        if (err) {
                            console.error('[herdr-collie] Failed to send agent command to pane:', err);
                        }
                        resolve();
                    });
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
