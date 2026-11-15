/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode';
import { mockState, resetMockState } from '../helpers/mockVscode';
import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import cp = require('child_process');
import { 
    sanitizeBranchSlug, 
    resolveWorktreePath,
    getInstalledAgentOptions,
    SUPPORTED_AGENT_DEFINITIONS,
    quoteForShell,
    buildAgentLaunchCommand,
    validateBranchName,
    parseMergeConflictFiles,
    formatMergeConflictPrompt,
    formatCreatePullRequestPrompt,
    openWorkspaceFolderInWindow,
    sanitizeAgentName,
    startAgentInPane
} from '../../worktreeManager';

describe('worktreeManager Unit Tests', () => {
    let originalExecFile: any;

    beforeEach(() => {
        resetMockState();
        originalExecFile = cp.execFile;
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
    });

    describe('quoteForShell', () => {
        it('quotes empty strings correctly', () => {
            expect(quoteForShell('')).to.equal("''");
        });

        it('wraps standard strings in single quotes', () => {
            expect(quoteForShell('hello world')).to.equal("'hello world'");
        });

        it('escapes embedded single quotes properly', () => {
            expect(quoteForShell("don't stop")).to.equal("'don'\\''t stop'");
        });

        it('preserves newlines and special shell characters literally', () => {
            const complex = 'Line 1\nLine 2 with $VAR and `backticks` and "quotes"';
            expect(quoteForShell(complex)).to.equal("'Line 1\nLine 2 with $VAR and `backticks` and \"quotes\"'");
        });
    });

    describe('buildAgentLaunchCommand', () => {
        it('returns empty string if agentCmd is empty (shell default)', () => {
            expect(buildAgentLaunchCommand('', 'Some prompt')).to.equal('');
        });

        it('returns bare agent command when no prompt is provided', () => {
            expect(buildAgentLaunchCommand('cursor-agent')).to.equal('cursor-agent');
            expect(buildAgentLaunchCommand('claude', '  ')).to.equal('claude');
        });

        it('appends safely quoted prompt to the agent command', () => {
            const cmd = buildAgentLaunchCommand('cursor-agent', 'Fix bug in auth service');
            expect(cmd).to.equal("cursor-agent 'Fix bug in auth service'");
        });

        it('handles custom commands with flags and prompts containing quotes', () => {
            const cmd = buildAgentLaunchCommand('claude --dangerously-skip-permissions', "It's working!");
            expect(cmd).to.equal("claude --dangerously-skip-permissions 'It'\\''s working!'");
        });

        it('normalizes embedded newlines in prompt to spaces to prevent terminal shell breakout', () => {
            const cmd = buildAgentLaunchCommand('claude', 'Line 1\nLine 2\r\nLine 3');
            expect(cmd).to.equal("claude 'Line 1 Line 2 Line 3'");
        });
    });

    describe('sanitizeBranchSlug', () => {
        it('replaces forward slashes and special characters with hyphens', () => {
            expect(sanitizeBranchSlug('feature/login-page')).to.equal('feature-login-page');
            expect(sanitizeBranchSlug('fix/issue#42/sub_task')).to.equal('fix-issue#42-sub_task');
            expect(sanitizeBranchSlug('feat///test///branch')).to.equal('feat-test-branch');
        });

        it('trims leading and trailing hyphens', () => {
            expect(sanitizeBranchSlug('/feature/branch/')).to.equal('feature-branch');
        });
    });

    describe('resolveWorktreePath', () => {
        it('resolves sibling directory path when location preference is sibling', () => {
            const repoRoot = path.join('/Users', 'test', 'apps', 'my-repo');
            const resolved = resolveWorktreePath(repoRoot, 'feat/auth-service', 'sibling');
            expect(resolved).to.equal(path.join('/Users', 'test', 'apps', 'my-repo-feat-auth-service'));
        });

        it('resolves .worktrees subfolder path when location preference is .worktrees', () => {
            const repoRoot = path.join('/Users', 'test', 'apps', 'my-repo');
            const resolved = resolveWorktreePath(repoRoot, 'feat/auth-service', '.worktrees');
            expect(resolved).to.equal(path.join('/Users', 'test', 'apps', 'my-repo', '.worktrees', 'feat-auth-service'));
        });
    });

    describe('getInstalledAgentOptions', () => {
        it('filters agent list to only installed binaries and always includes shell and custom', async () => {
            // Mock cp.execFile to only return success for 'claude' and 'cursor-agent'
            (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
                const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
                const binary = (args && args.length > 0) ? args[0] : file;
                if (binary === 'claude' || binary === 'cursor-agent') {
                    cb(null, '/usr/local/bin/' + binary, '');
                } else {
                    cb(new Error('not found'), '', '');
                }
                return {} as any;
            };

            const options = await getInstalledAgentOptions();
            const commands = options.map(o => o.cmd);

            expect(commands).to.include('claude');
            expect(commands).to.include('cursor-agent');
            expect(commands).to.not.include('agy');
            expect(commands).to.not.include('codex');
            expect(commands).to.not.include('devin');

            // Must always contain default shell and custom
            expect(commands).to.include('');
            expect(commands).to.include('CUSTOM');
        });
    });

    describe('validateBranchName', () => {
        it('returns error if branch name is empty or only whitespace', () => {
            expect(validateBranchName('')).to.equal('Branch name cannot be empty');
            expect(validateBranchName('   ')).to.equal('Branch name cannot be empty');
        });

        it('returns error if branch name starts with hyphen to prevent option injection', () => {
            expect(validateBranchName('-b')).to.equal('Branch name cannot start with a hyphen (-)');
            expect(validateBranchName('--output=evil')).to.equal('Branch name cannot start with a hyphen (-)');
        });

        it('returns error if branch name contains spaces', () => {
            expect(validateBranchName('feat branch')).to.equal('Branch name cannot contain spaces');
        });

        it('returns error if branch name contains invalid git ref characters', () => {
            expect(validateBranchName('feat..branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat~1')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat^1')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat:branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat?branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat*branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat[branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat@{1}')).to.equal('Branch name contains invalid Git ref characters');
        });

        it('returns null for valid branch names', () => {
            expect(validateBranchName('feat/user-auth')).to.be.null;
            expect(validateBranchName('fix/issue_42')).to.be.null;
            expect(validateBranchName('main')).to.be.null;
            expect(validateBranchName('release-1.0.0')).to.be.null;
        });
    });

    describe('Pre-Merge Verification & Conflict Prompt Formatting', () => {
        it('extracts conflicting file paths from git merge-tree / merge output', () => {
            const sampleOutput = [
                'Auto-merging src/extension.ts',
                'CONFLICT (content): Merge conflict in src/extension.ts',
                'CONFLICT (add/add): Merge conflict in src/agentHUD.ts',
                'Automatic merge failed; fix conflicts and then commit the result.'
            ].join('\n');

            const files = parseMergeConflictFiles(sampleOutput);
            expect(files).to.deep.equal(['src/extension.ts', 'src/agentHUD.ts']);
        });

        it('formats structured conflict resolution prompt for worktree agent', () => {
            const prompt = formatMergeConflictPrompt('feat/swarm-ui', 'main', {
                uncommittedFiles: ['src/temp.ts'],
                conflictingFiles: ['src/extension.ts'],
                errorDetails: 'CONFLICT (content): Merge conflict in src/extension.ts'
            });

            expect(prompt).to.include('## ⚠️ Pre-Merge Verification Failed (`feat/swarm-ui` → `main`)');
            expect(prompt).to.include('`src/temp.ts`');
            expect(prompt).to.include('`src/extension.ts`');
            expect(prompt).to.include('Merge or rebase `main` into `feat/swarm-ui`');
        });
    });

    describe('openWorkspaceFolderInWindow', () => {
        it('returns false when targetPath is empty or does not exist on disk', async () => {
            expect(await openWorkspaceFolderInWindow('')).to.be.false;
            expect(await openWorkspaceFolderInWindow('   ')).to.be.false;
            expect(await openWorkspaceFolderInWindow(undefined)).to.be.false;
            expect(await openWorkspaceFolderInWindow(path.join(os.tmpdir(), 'non-existent-herdr-dir-999999'))).to.be.false;
            expect(mockState.executedCommands).to.be.empty;
        });

        it('opens existing workspace directory in a new VS Code window via vscode.openFolder', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-open-win-'));
            try {
                const opened = await openWorkspaceFolderInWindow(tempDir, true);
                expect(opened).to.be.true;
                expect(mockState.executedCommands).to.have.lengthOf(1);
                expect(mockState.executedCommands[0].command).to.equal('vscode.openFolder');
                expect(mockState.executedCommands[0].args[0].fsPath).to.equal(path.resolve(tempDir));
                expect(mockState.executedCommands[0].args[1]).to.deep.equal({ forceNewWindow: true });
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('Protocol 22 Agent Start & Integration Helpers', () => {
        it('sanitizeAgentName produces valid [a-z][a-z0-9_-]{0,31} identifiers and avoids collisions', () => {
            expect(sanitizeAgentName('feat/OAuth2-Login!')).to.equal('feat-oauth2-login');
            expect(sanitizeAgentName('123-fix-bug')).to.equal('fix-bug');
            expect(sanitizeAgentName('---')).to.equal('agent');

            const longName = sanitizeAgentName('very-long-branch-name-that-exceeds-thirty-two-chars');
            expect(longName.length).to.be.at.most(32);
            expect(longName).to.match(/^[a-z][a-z0-9_-]{0,31}$/);

            const existing = new Set(['feat-auth', 'feat-auth-2']);
            const deduped = sanitizeAgentName('feat/auth', existing);
            expect(deduped).to.equal('feat-auth-3');
        });

        it('getInstalledAgentOptions enriches installed agents with integration state badges', async () => {
            cp.execFile = ((cmd: string, args: any, opts: any, cb: any) => {
                const callback = typeof opts === 'function' ? opts : cb;
                if (cmd === 'which' && (args?.[0] === 'claude' || args?.[0] === 'agy')) {
                    callback(null, `/usr/local/bin/${args[0]}`, '');
                    return {} as any;
                }
                callback(new Error('not found'), '', '');
                return {} as any;
            }) as any;

            const integrations = [
                {
                    target: 'claude',
                    cliTarget: 'claude',
                    socketTarget: 'claude',
                    label: 'Claude Code',
                    command: 'claude',
                    available: true,
                    state: 'current' as const
                },
                {
                    target: 'antigravity-cli',
                    cliTarget: 'antigravity-cli',
                    socketTarget: 'antigravity_cli',
                    label: 'Antigravity CLI',
                    command: 'agy',
                    available: true,
                    state: 'outdated' as const
                }
            ];

            const options = await getInstalledAgentOptions(undefined, integrations);
            const claudeOpt = options.find(o => o.cmd === 'claude');
            const agyOpt = options.find(o => o.cmd === 'agy');
            expect(claudeOpt?.description).to.include('✓');
            expect(claudeOpt?.description).to.include('integrated');
            expect(agyOpt?.description).to.include('⚠️');
            expect(agyOpt?.description).to.include('integration outdated');
        });

        it('startAgentInPane uses native agent.start + agent.prompt over socket when agentKind is known', async () => {
            const calls: Array<{ method: string; args: any[] }> = [];
            const fakeSocket = {
                isConnected: true,
                startAgent: async (params: any) => {
                    calls.push({ method: 'startAgent', args: [params] });
                    return {};
                },
                sendAgentPrompt: async (agentId: string, prompt: string) => {
                    calls.push({ method: 'sendAgentPrompt', args: [agentId, prompt] });
                },
                sendPaneInput: async (paneId: string, text: string, keys?: string[]) => {
                    calls.push({ method: 'sendPaneInput', args: [paneId, text, keys] });
                }
            } as any;

            const result = await startAgentInPane({
                sessionName: 'vscode',
                paneId: 'w1:p1',
                agentName: 'feat-auth',
                agentCmd: 'claude',
                agentKind: 'claude',
                prompt: 'Implement login',
                cwd: '/repo',
                socketClient: fakeSocket
            });

            expect(result).to.deep.equal({ method: 'native', started: true, prompted: true });
            expect(calls).to.have.lengthOf(2);
            expect(calls[0].method).to.equal('startAgent');
            expect(calls[0].args[0]).to.deep.include({
                name: 'feat-auth',
                kind: 'claude',
                paneId: 'w1:p1'
            });
            expect(calls[1].method).to.equal('sendAgentPrompt');
            expect(calls[1].args).to.deep.equal(['feat-auth', 'Implement login']);
        });

        it('startAgentInPane falls back to pane.send_input when agent.start fails or custom command is used', async () => {
            const calls: Array<{ method: string; args: any[] }> = [];
            const fakeSocket = {
                isConnected: true,
                startAgent: async () => {
                    throw new Error('unsupported');
                },
                sendPaneInput: async (paneId: string, text: string, keys?: string[]) => {
                    calls.push({ method: 'sendPaneInput', args: [paneId, text, keys] });
                }
            } as any;

            const result = await startAgentInPane({
                sessionName: 'vscode',
                paneId: 'w1:p1',
                agentName: 'custom-run',
                agentCmd: 'custom-agent',
                prompt: 'Fix tests\nnow',
                cwd: '/repo',
                socketClient: fakeSocket
            });

            expect(result).to.deep.equal({ method: 'fallback', started: true, prompted: true });
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].method).to.equal('sendPaneInput');
            expect(calls[0].args[0]).to.equal('w1:p1');
            expect(calls[0].args[1]).to.equal("custom-agent 'Fix tests now'");
            expect(calls[0].args[2]).to.deep.equal(['enter']);
        });

        it('formatCreatePullRequestPrompt generates structured gh pr create instructions', () => {
            const prompt = formatCreatePullRequestPrompt('feat/cross-review', 'main', 'Mark as draft PR');
            expect(prompt).to.include('`feat/cross-review`');
            expect(prompt).to.include('`main`');
            expect(prompt).to.include('gh pr create --base');
            expect(prompt).to.include('Mark as draft PR');
        });
    });
});
