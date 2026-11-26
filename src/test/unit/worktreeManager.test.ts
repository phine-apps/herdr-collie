/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode';
import { mockState, mockVscode, resetMockState } from '../helpers/mockVscode';
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
    startAgentInPane,
    DEFAULT_WORKTREE_COPY_FILES,
    getWorktreeBootstrapOptions,
    bootstrapWorktreeEnvironment,
    parseGitDiffShortStat,
    formatWorktreeScorecardBadge,
    WorktreeScorecard,
    parseGitHubIssuesJson,
    suggestBranchNameFromIssue,
    fetchOpenGitHubIssues,
    parseFailingPrChecksJson,
    extractGitHubRunIdFromUrl,
    fetchFailingPrChecksWithLogs,
    launchWorktreeAgentWizard
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
            expect(validateBranchName('.')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('/')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('/leading')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('trailing/')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('trailing.')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('branch.lock')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('@')).to.equal('Branch name contains invalid Git ref characters');
            expect(() => resolveWorktreePath('/repo', '.', '.worktrees')).to.throw();
            expect(() => resolveWorktreePath('/repo', '/', '.worktrees')).to.throw();
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

    describe('Worktree Bootstrap (copyFiles & postCreateCommand)', () => {
        let tempRoot: string;
        let repoRoot: string;
        let worktreePath: string;

        beforeEach(() => {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-boot-'));
            repoRoot = path.join(tempRoot, 'repo');
            worktreePath = path.join(tempRoot, 'repo-wt');
            fs.mkdirSync(repoRoot, { recursive: true });
            fs.mkdirSync(worktreePath, { recursive: true });
        });

        afterEach(() => {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        });

        it('getWorktreeBootstrapOptions returns defaults and honors custom configuration', () => {
            const defaults = getWorktreeBootstrapOptions();
            expect(defaults.copyFiles).to.deep.equal(DEFAULT_WORKTREE_COPY_FILES);
            expect(defaults.postCreateCommand).to.equal('');

            mockState.configurations.set('herdr-collie.worktree.copyFiles', ['.env', 'apps/web/.env.local']);
            mockState.configurations.set('herdr-collie.worktree.postCreateCommand', '  pnpm install --prefer-offline  ');

            const custom = getWorktreeBootstrapOptions();
            expect(custom.copyFiles).to.deep.equal(['.env', 'apps/web/.env.local']);
            expect(custom.postCreateCommand).to.equal('pnpm install --prefer-offline');
        });

        it('copies configured untracked files including nested paths without overwriting existing files', async () => {
            fs.writeFileSync(path.join(repoRoot, '.env'), 'SECRET=from-main\n', 'utf8');
            fs.mkdirSync(path.join(repoRoot, 'apps', 'web'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'apps', 'web', '.env.local'), 'PORT=3000\n', 'utf8');
            fs.writeFileSync(path.join(worktreePath, '.env.local'), 'EXISTING=keep\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, '.env.local'), 'NEW=skip-me\n', 'utf8');

            const res = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, {
                copyFiles: ['.env', '.env.local', 'apps/web/.env.local', '.env.missing']
            });

            expect(res.copiedFiles).to.deep.equal(['.env', 'apps/web/.env.local']);
            expect(res.skippedFiles).to.include.members(['.env.local', '.env.missing']);
            expect(res.warnings).to.be.empty;
            expect(res.postCreateRan).to.be.false;
            expect(res.postCreateSucceeded).to.be.true;
            expect(fs.readFileSync(path.join(worktreePath, '.env'), 'utf8')).to.equal('SECRET=from-main\n');
            expect(fs.readFileSync(path.join(worktreePath, 'apps', 'web', '.env.local'), 'utf8')).to.equal('PORT=3000\n');
            expect(fs.readFileSync(path.join(worktreePath, '.env.local'), 'utf8')).to.equal('EXISTING=keep\n');
        });

        it('rejects path traversal, absolute paths, and symlinks escaping repoRoot', async () => {
            const outsideSecret = path.join(tempRoot, 'outside-secret.env');
            fs.writeFileSync(outsideSecret, 'TOP_SECRET=1\n', 'utf8');
            const symlinkPath = path.join(repoRoot, '.env.link');
            fs.symlinkSync(outsideSecret, symlinkPath);

            const res = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, {
                copyFiles: ['../outside-secret.env', outsideSecret, '.env.link']
            });

            expect(res.copiedFiles).to.be.empty;
            expect(res.warnings).to.have.lengthOf(3);
            expect(fs.existsSync(path.join(worktreePath, '.env.link'))).to.be.false;
            expect(fs.existsSync(path.join(worktreePath, 'outside-secret.env'))).to.be.false;
        });

        it('rejects destination directory symlinks and dangling symlinks inside worktreePath', async () => {
            fs.writeFileSync(path.join(repoRoot, '.env'), 'SECRET=1\n', 'utf8');
            fs.mkdirSync(path.join(repoRoot, 'apps', 'web'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'apps', 'web', '.env.local'), 'PORT=3000\n', 'utf8');

            const outsideDir = path.join(tempRoot, 'outside-dir');
            fs.mkdirSync(outsideDir, { recursive: true });
            fs.symlinkSync(outsideDir, path.join(worktreePath, 'apps'));

            const outsideTarget = path.join(tempRoot, 'does-not-exist-yet.env');
            fs.symlinkSync(outsideTarget, path.join(worktreePath, '.env'));

            const res = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, {
                copyFiles: ['.env', 'apps/web/.env.local']
            });

            expect(res.copiedFiles).to.be.empty;
            expect(res.warnings).to.have.lengthOf(2);
            expect(fs.existsSync(outsideTarget)).to.be.false;
            expect(fs.existsSync(path.join(outsideDir, 'web', '.env.local'))).to.be.false;
        });

        it('skips postCreateCommand with a warning when workspace is not trusted', async () => {
            let execCalled = false;
            (cp as any).execFile = (_file: string, _args: string[], _opts: any, cb: any) => {
                execCalled = true;
                cb(null, '', '');
                return {} as any;
            };
            mockVscode.workspace.isTrusted = false;

            const res = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, {
                copyFiles: [],
                postCreateCommand: 'echo pwned'
            });

            expect(execCalled).to.be.false;
            expect(res.postCreateRan).to.be.false;
            expect(res.postCreateSucceeded).to.be.false;
            expect(res.warnings).to.deep.equal(['Skipped postCreateCommand because the workspace is not trusted.']);
        });

        it('runs postCreateCommand in worktreePath with clean HERDR_* env and handles failures non-fatally', async () => {
            const origWorkspace = process.env['HERDR_WORKSPACE'];
            process.env['HERDR_WORKSPACE'] = 'nested-ws';

            let capturedCwd: string | undefined;
            let capturedEnv: any;
            (cp as any).execFile = (_file: string, _args: string[], opts: any, cb: any) => {
                capturedCwd = opts?.cwd;
                capturedEnv = opts?.env;
                cb(null, 'ok', '');
                return {} as any;
            };

            try {
                const okRes = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, {
                    copyFiles: [],
                    postCreateCommand: 'pnpm install --prefer-offline'
                });
                expect(okRes.postCreateRan).to.be.true;
                expect(okRes.postCreateSucceeded).to.be.true;
                expect(okRes.warnings).to.be.empty;
                expect(capturedCwd).to.equal(worktreePath);
                expect(capturedEnv).to.not.have.property('HERDR_WORKSPACE');

                (cp as any).execFile = (_file: string, _args: string[], _opts: any, cb: any) => {
                    cb(new Error('exit code 1'), '', 'ERR_PNPM_LOCKFILE');
                    return {} as any;
                };

                const failRes = await bootstrapWorktreeEnvironment(repoRoot, worktreePath, {
                    copyFiles: [],
                    postCreateCommand: 'pnpm install'
                });
                expect(failRes.postCreateRan).to.be.true;
                expect(failRes.postCreateSucceeded).to.be.false;
                expect(failRes.warnings).to.have.lengthOf(1);
                expect(failRes.warnings[0]).to.include('ERR_PNPM_LOCKFILE');
            } finally {
                if (origWorkspace !== undefined) {
                    process.env['HERDR_WORKSPACE'] = origWorkspace;
                } else {
                    delete process.env['HERDR_WORKSPACE'];
                }
            }
        });
    });

    describe('Worktree Comparison Scorecard (parseGitDiffShortStat & formatWorktreeScorecardBadge)', () => {
        it('parses git diff --shortstat variants accurately', () => {
            expect(parseGitDiffShortStat('')).to.deep.equal({ filesChanged: 0, insertions: 0, deletions: 0 });
            expect(parseGitDiffShortStat(' 1 file changed, 12 insertions(+)\n')).to.deep.equal({
                filesChanged: 1,
                insertions: 12,
                deletions: 0
            });
            expect(parseGitDiffShortStat(' 2 files changed, 7 deletions(-)\n')).to.deep.equal({
                filesChanged: 2,
                insertions: 0,
                deletions: 7
            });
            expect(parseGitDiffShortStat(' 5 files changed, 48 insertions(+), 13 deletions(-)\n')).to.deep.equal({
                filesChanged: 5,
                insertions: 48,
                deletions: 13
            });
        });

        it('formats concise scorecard badges across clean, uncommitted, conflicting, and LSP error states', () => {
            const baseCard: WorktreeScorecard = {
                branchName: 'swarm/best-1',
                worktreePath: '/repos/demo-swarm-best-1',
                baseBranch: 'main',
                filesChanged: 3,
                insertions: 48,
                deletions: 12,
                untrackedFiles: 0,
                canMerge: true,
                hasConflicts: false,
                conflictingFilesCount: 0,
                hasUncommittedChanges: false,
                uncommittedFilesCount: 0,
                lspErrorCount: 0
            };

            expect(formatWorktreeScorecardBadge(baseCard)).to.equal('3 files (+48/-12) • ✓ Clean merge • 0 LSP errors');

            expect(
                formatWorktreeScorecardBadge({
                    ...baseCard,
                    filesChanged: 0,
                    insertions: 0,
                    deletions: 0,
                    canMerge: false,
                    hasUncommittedChanges: true,
                    uncommittedFilesCount: 2,
                    lspErrorCount: 3
                })
            ).to.equal('No changes • ⚠️ 2 uncommitted • 🔴 3 LSP errors');

            expect(
                formatWorktreeScorecardBadge({
                    ...baseCard,
                    canMerge: false,
                    hasConflicts: true,
                    conflictingFilesCount: 2
                })
            ).to.equal('3 files (+48/-12) • ⚠️ 2 conflicts • 0 LSP errors');

            expect(
                formatWorktreeScorecardBadge({
                    ...baseCard,
                    canMerge: false,
                    hasConflicts: true,
                    conflictingFilesCount: 0
                })
            ).to.equal('3 files (+48/-12) • ⚠️ Merge conflict • 0 LSP errors');

            expect(
                formatWorktreeScorecardBadge({
                    ...baseCard,
                    filesChanged: 1,
                    insertions: 5,
                    deletions: 1,
                    canMerge: false
                })
            ).to.equal('1 file (+5/-1) • ⚠️ Cannot merge • 0 LSP errors');
        });
    });

    describe('GitHub CLI (gh) Issue & Failing PR Check Helpers', () => {
        it('parseGitHubIssuesJson and suggestBranchNameFromIssue handle valid, non-ASCII, and malformed inputs', () => {
            const raw = JSON.stringify([
                {
                    number: 101,
                    title: 'Fix OAuth2 callback & token refresh!',
                    body: 'Details',
                    url: 'https://github.com/org/repo/issues/101',
                    labels: [{ name: 'bug' }, { name: 'high-priority' }]
                },
                {
                    number: 102,
                    title: 'ログイン画面のレイアウト修正',
                    labels: []
                }
            ]);

            const parsed = parseGitHubIssuesJson(raw);
            expect(parsed).to.have.lengthOf(2);
            expect(parsed[0].labels).to.deep.equal(['bug', 'high-priority']);
            expect(suggestBranchNameFromIssue(parsed[0])).to.equal('issue-101-fix-oauth2-callback-token-refresh');
            expect(validateBranchName(suggestBranchNameFromIssue(parsed[0]))).to.be.null;
            expect(suggestBranchNameFromIssue(parsed[1])).to.equal('issue-102');
            expect(validateBranchName(suggestBranchNameFromIssue(parsed[1]))).to.be.null;

            expect(parseGitHubIssuesJson('not-json')).to.deep.equal([]);
        });

        it('fetchOpenGitHubIssues invokes gh with discrete args and falls back to empty array on failure', async () => {
            let capturedArgs: string[] = [];
            (cp as any).execFile = (file: string, args: string[], _opts: any, cb: any) => {
                expect(file).to.equal('gh');
                capturedArgs = args;
                cb(null, JSON.stringify([{ number: 7, title: 'Add dark mode', labels: [] }]), '');
                return {} as any;
            };

            const issues = await fetchOpenGitHubIssues('/repos/demo', 15);
            expect(capturedArgs).to.include.members(['issue', 'list', '--state', 'open', '--limit', '15']);
            expect(issues).to.have.lengthOf(1);
            expect(issues[0].number).to.equal(7);

            (cp as any).execFile = (_file: string, _args: string[], _opts: any, cb: any) => {
                cb(new Error('gh not authenticated'), '', 'not logged in');
                return {} as any;
            };
            expect(await fetchOpenGitHubIssues('/repos/demo')).to.deep.equal([]);
        });

        it('parseFailingPrChecksJson, extractGitHubRunIdFromUrl, and fetchFailingPrChecksWithLogs extract failing CI checks and log tail', async () => {
            const rawChecks = JSON.stringify([
                { name: 'lint', state: 'SUCCESS', link: 'https://github.com/org/repo/actions/runs/111/job/1' },
                { name: 'test', state: 'FAILURE', description: '2 tests failed', link: 'https://github.com/org/repo/actions/runs/222333/job/9' },
                { name: 'build', state: 'PENDING', bucket: 'fail', link: 'https://github.com/org/repo/actions/runs/222333/job/10' }
            ]);

            const failing = parseFailingPrChecksJson(rawChecks);
            expect(failing).to.have.lengthOf(2);
            expect(failing.map(f => f.name)).to.deep.equal(['test', 'build']);
            expect(extractGitHubRunIdFromUrl(failing[0].link)).to.equal('222333');
            expect(extractGitHubRunIdFromUrl('https://example.com/no-run')).to.be.null;

            (cp as any).execFile = (_file: string, args: string[], _opts: any, cb: any) => {
                if (args[0] === 'pr' && args[1] === 'checks') {
                    // Simulate older gh CLI rejecting `bucket` JSON field, then succeeding on fallback
                    if (args.includes('name,state,bucket,link,description')) {
                        cb(new Error('exit 1'), '', 'Unknown JSON field: "bucket"');
                        return {} as any;
                    }
                    // gh pr checks often exits 1 when checks fail, while still returning valid JSON stdout
                    cb(new Error('exit code 1'), rawChecks, '');
                    return {} as any;
                }
                if (args[0] === 'run' && args[1] === 'view') {
                    expect(args).to.deep.equal(['run', 'view', '222333', '--log-failed']);
                    cb(null, '\x1b[31mAssertionError: expected 1 to equal 2\x1b[0m', '');
                    return {} as any;
                }
                cb(new Error('unexpected args'), '', '');
                return {} as any;
            };

            const res = await fetchFailingPrChecksWithLogs('/repos/demo-wt', 'fix/test');
            expect(res.prError).to.be.undefined;
            expect(res.checks).to.have.lengthOf(2);
            expect(res.logSnippet).to.equal('AssertionError: expected 1 to equal 2');

            (cp as any).execFile = (_file: string, _args: string[], _opts: any, cb: any) => {
                cb(new Error('exit 1'), '', 'no pull requests found for branch "fix/no-pr"');
                return {} as any;
            };
            const noPr = await fetchFailingPrChecksWithLogs('/repos/demo-wt', 'fix/no-pr');
            expect(noPr.checks).to.be.empty;
            expect(noPr.prError).to.include('no pull requests found');
        });
    });

    describe('launchWorktreeAgentWizard Safety & Failure Handling', () => {
        let tempRoot: string;
        let origShowInputBox: any;
        let origShowQuickPick: any;
        let origWorkspaceFolders: PropertyDescriptor | undefined;

        beforeEach(() => {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-wizard-test-'));
            origShowInputBox = mockVscode.window.showInputBox;
            origShowQuickPick = mockVscode.window.showQuickPick;
            origWorkspaceFolders = Object.getOwnPropertyDescriptor(mockVscode.workspace, 'workspaceFolders');
        });

        afterEach(() => {
            mockVscode.window.showInputBox = origShowInputBox;
            mockVscode.window.showQuickPick = origShowQuickPick;
            if (origWorkspaceFolders) {
                Object.defineProperty(mockVscode.workspace, 'workspaceFolders', origWorkspaceFolders);
            } else {
                delete (mockVscode.workspace as any).workspaceFolders;
            }
            fs.rmSync(tempRoot, { recursive: true, force: true });
        });

        it('rejects whitespace-only CUSTOM agent command and avoids false success notification when startAgentInPane fails', async () => {
            const repoDir = path.join(tempRoot, 'repo');
            fs.mkdirSync(repoDir, { recursive: true });
            const { execFileSync } = require('child_process');
            execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
            execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
            execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
            fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n', 'utf8');
            execFileSync('git', ['add', '.'], { cwd: repoDir });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

            Object.defineProperty(mockVscode.workspace, 'workspaceFolders', {
                configurable: true,
                get: () => [{ uri: { fsPath: repoDir }, name: 'repo', index: 0 }]
            });

            (cp as any).execFile = (file: string, args: string[], optionsOrCb?: any, cb?: any) => {
                if (file === 'git') {
                    return originalExecFile.call(cp, file, args, optionsOrCb, cb);
                }
                const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
                if (file === 'which' || file === 'where') {
                    callback?.(new Error('not found'), '', '');
                    return {} as any;
                }
                if (file.includes('herdr')) {
                    // workspace / pane succeeds ONLY if explicitly called, agent start fails
                    if (args.includes('agent') && args.includes('start')) {
                        callback?.(new Error('agent start rejected'), '', 'agent start rejected');
                        return {} as any;
                    }
                    callback?.(new Error('cli error'), '', '');
                    return {} as any;
                }
                callback?.(new Error('unexpected command'), '', '');
                return {} as any;
            };

            // Case 1: CUSTOM selected with whitespace-only command -> must abort before creating worktree
            let inputStep = 0;
            mockVscode.window.showInputBox = async () => {
                inputStep++;
                return inputStep === 1 ? 'feat/blank-custom' : '   ';
            };
            mockVscode.window.showQuickPick = async (items: any[]) => {
                const baseMatch = items.find((i: any) => i.branchName === 'main');
                if (baseMatch) return baseMatch;
                return items.find((i: any) => i.cmd === 'CUSTOM');
            };

            const mockSocket: any = {
                isConnected: true,
                getSnapshot: async () => ({ agents: [] }),
                listIntegrations: async () => [],
                createWorkspace: async () => ({
                    workspace: { workspace_id: 'w1' },
                    tab: { tab_id: 'w1:t1' },
                    root_pane: { pane_id: 'w1:p1' }
                }),
                startAgent: async () => { throw new Error('rpc start failed'); },
                request: async () => { throw new Error('rpc request failed'); }
            };

            await launchWorktreeAgentWizard('vscode', undefined, mockSocket);
            expect(inputStep).to.equal(2);
            expect(fs.existsSync(path.join(tempRoot, 'repo-feat-blank-custom'))).to.be.false;

            // Case 2: Valid CUSTOM agent command, workspace succeeds, but startAgentInPane fails -> must warn, NOT show "🚀 Agent launched"
            resetMockState();
            inputStep = 0;
            mockVscode.window.showInputBox = async () => {
                inputStep++;
                if (inputStep === 1) return 'feat/launch-fail';
                if (inputStep === 2) return 'my-custom-agent';
                return 'implement x';
            };
            mockVscode.window.showQuickPick = async (items: any[]) => {
                const baseMatch = items.find((i: any) => i.branchName === 'main');
                if (baseMatch) return baseMatch;
                return items.find((i: any) => i.cmd === 'CUSTOM');
            };

            await launchWorktreeAgentWizard('vscode', undefined, mockSocket);
            expect(inputStep).to.equal(3);
            expect(mockState.lastWarningMessage?.message).to.include('failed to launch agent');
            expect(mockState.lastInformationMessage).to.be.undefined;
        });
    });
});
