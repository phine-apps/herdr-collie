/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as l10n from '@vscode/l10n';
import {
    formatSelectionContext,
    formatFileDiagnostics,
    formatWorkspaceProblems,
    formatGitDiff,
    formatBranchContext,
    formatHoverInfo,
    formatTerminalOutput,
    formatAgentDisplay,
    formatWorkspaceDisplay,
    sortAgents,
    formatCodeFence
} from '../../formatters';
import { ParsedAgent, ParsedWorkspace, GitWorktreeInfo } from '../../parsers';

describe('formatters Unit Tests', () => {
    describe('formatSelectionContext', () => {
        it('formats single line selection', () => {
            const result = formatSelectionContext('src/app.ts', 10, 10, 'typescript', 'const x = 1;');
            expect(result).to.equal('`src/app.ts` (Line 10):\n```typescript\nconst x = 1;\n```');
        });

        it('formats multi line selection', () => {
            const result = formatSelectionContext('src/app.ts', 10, 15, 'typescript', 'function foo() {\n  return 42;\n}');
            expect(result).to.equal('`src/app.ts` (Lines 10-15):\n```typescript\nfunction foo() {\n  return 42;\n}\n```');
        });
    });

    describe('formatFileDiagnostics', () => {
        it('returns empty string if diagnostics array is empty', () => {
            expect(formatFileDiagnostics('src/app.ts', [])).to.equal('');
        });

        it('formats multiple diagnostic items', () => {
            const result = formatFileDiagnostics('src/app.ts', [
                { line: 5, message: 'Variable not used' },
                { line: 12, message: 'Type mismatch' }
            ]);
            expect(result).to.include('The following errors are present in `src/app.ts`:');
            expect(result).to.include('Line 5: Variable not used');
            expect(result).to.include('Line 12: Type mismatch');
            expect(result).to.include('Please fix them.');
        });
    });

    describe('formatWorkspaceProblems', () => {
        it('returns empty string when no problems exist', () => {
            expect(formatWorkspaceProblems({})).to.equal('');
            expect(formatWorkspaceProblems({ 'file.ts': [] })).to.equal('');
        });

        it('formats workspace errors and warnings grouped by file', () => {
            const result = formatWorkspaceProblems({
                'src/a.ts': [
                    { line: 1, severity: 'Error', message: 'Syntax error' },
                    { line: 5, severity: 'Warning', message: 'Unused var' }
                ],
                'src/b.ts': [
                    { line: 20, severity: 'Error', message: 'Cannot find name' }
                ]
            });
            expect(result).to.include('### `src/a.ts`');
            expect(result).to.include('- **Line 1** [Error]: Syntax error');
            expect(result).to.include('- **Line 5** [Warning]: Unused var');
            expect(result).to.include('### `src/b.ts`');
            expect(result).to.include('- **Line 20** [Error]: Cannot find name');
        });
    });

    describe('formatGitDiff', () => {
        it('formats staged diff for whole repo', () => {
            const result = formatGitDiff('diff --git a/test.ts b/test.ts', undefined, true);
            expect(result).to.include('Here is the staged git diff:');
            expect(result).to.include('Please review these staged changes.');
        });

        it('formats working tree diff for single file', () => {
            const result = formatGitDiff('diff --git a/test.ts b/test.ts', 'src/test.ts', false);
            expect(result).to.include('Here is the working tree (unstaged) git diff for `src/test.ts`:');
            expect(result).to.include('Please review these changes.');
        });

        it('truncates very large diffs beyond 50,000 characters', () => {
            const hugeDiff = 'x'.repeat(60000);
            const result = formatGitDiff(hugeDiff, 'huge.ts', false);
            expect(result).to.include('... (truncated)');
            expect(result.length).to.be.lessThan(55000);
        });
    });

    describe('formatBranchContext', () => {
        it('formats branch name and recent commits', () => {
            const result = formatBranchContext('feature/login', 'a1b2c3d Add login UI\ne4f5g6h Fix auth');
            expect(result).to.include('**Current Branch:** `feature/login`');
            expect(result).to.include('a1b2c3d Add login UI');
        });
    });

    describe('formatHoverInfo', () => {
        it('formats hover text and symbol name', () => {
            const result = formatHoverInfo('calculateSum', ['(function) calculateSum(a: number, b: number): number', 'Computes sum of numbers']);
            expect(result).to.include('Here is the type and documentation info for `calculateSum`:');
            expect(result).to.include('(function) calculateSum(a: number, b: number): number');
            expect(result).to.include('Computes sum of numbers');
        });
    });

    describe('formatTerminalOutput', () => {
        it('returns empty string if output text is whitespace or empty', () => {
            expect(formatTerminalOutput('bash', '')).to.equal('');
            expect(formatTerminalOutput('bash', '   \n  ')).to.equal('');
        });

        it('formats general terminal output without command or exit code', () => {
            const result = formatTerminalOutput('zsh', 'Hello World\nBuild passed');
            expect(result).to.include('Here is the terminal output from `zsh`:');
            expect(result).to.include('Hello World\nBuild passed');
            expect(result).to.include('Please review this terminal output.');
        });

        it('formats failed command execution with non-zero exit code', () => {
            const result = formatTerminalOutput('zsh', 'Error: Cannot find module foo', 'npm test', 1);
            expect(result).to.include('Here is the terminal output for command `npm test` (Terminal: `zsh`):');
            expect(result).to.include('**Exit Code:** `1` (Execution failed)');
            expect(result).to.include('Error: Cannot find module foo');
            expect(result).to.include('Please analyze this terminal failure/error and help me fix the issue.');
        });

        it('formats successful command execution with exit code 0', () => {
            const result = formatTerminalOutput('zsh', 'All 10 tests passed', 'pytest', 0);
            expect(result).to.include('Here is the terminal output for command `pytest` (Terminal: `zsh`):');
            expect(result).to.include('**Exit Code:** `0` (Success)');
            expect(result).to.include('All 10 tests passed');
            expect(result).to.include('Please review this terminal output.');
        });

        it('truncates very long terminal output (>50000 chars)', () => {
            const longText = 'log line\n'.repeat(7000);
            const result = formatTerminalOutput('zsh', longText);
            expect(result).to.include('... (truncated)');
            expect(result.length).to.be.lessThan(55000);
        });
    });

    describe('formatAgentDisplay', () => {
        it('formats agent with standard workspace label and idle status (omitting redundant State text)', () => {
            const agent: ParsedAgent = {
                id: 'w1:p1',
                name: 'cursor',
                status: 'idle',
                statusType: 'idle',
                statusIcon: '🟡',
                isWorking: false,
                isBlocked: false,
                workspaceId: 'w1',
                workspaceLabel: 'herdr-collie',
                workspaceCwd: '/path/to/herdr-collie'
            };

            const result = formatAgentDisplay(agent);
            expect(result.label).to.equal('🟡 cursor');
            expect(result.description).to.equal('herdr-collie');
            expect(result.displayLabel).to.equal('cursor [herdr-collie]');
            expect(result.tooltip).to.include('Agent: cursor');
            expect(result.tooltip).to.include('Workspace: herdr-collie');
            expect(result.tooltip).to.include('Path: /path/to/herdr-collie');
            expect(result.tooltip).to.include('Pane ID: w1:p1');
            expect(result.tooltip).to.include('Status: idle');
            expect(result.tooltip).to.not.include('Waiting for user confirmation');
        });

        it('formats agent with Git worktree and branch badge', () => {
            const agent: ParsedAgent = {
                id: 'wD:p1',
                name: 'agy',
                status: 'done',
                statusType: 'done',
                statusIcon: '⚪',
                isWorking: false,
                isBlocked: false,
                workspaceId: 'wD',
                workspaceLabel: 'electric-prophet',
                workspaceCwd: '/path/to/electric-prophet'
            };

            const worktrees: GitWorktreeInfo[] = [
                {
                    worktree: '/path/to/electric-prophet',
                    head: 'abc1234',
                    branch: 'main'
                }
            ];

            const result = formatAgentDisplay(agent, worktrees);
            expect(result.label).to.equal('⚪ agy');
            expect(result.description).to.equal('electric-prophet (main)');
            expect(result.displayLabel).to.equal('agy [electric-prophet (main)]');
            expect(result.tooltip).to.include('Branch: main');
            expect(result.tooltip).to.include('Status: done');
        });

        it('formats blocked agent with warning description and tooltip', () => {
            const agent: ParsedAgent = {
                id: 'w1:p2',
                name: 'claude',
                status: 'blocked',
                statusType: 'blocked',
                statusIcon: '🔴',
                isWorking: false,
                isBlocked: true,
                workspaceId: 'w1',
                workspaceLabel: 'herdr-collie'
            };

            const result = formatAgentDisplay(agent);
            expect(result.label).to.equal('🔴 claude');
            expect(result.description).to.equal('Input Needed • herdr-collie');
            expect(result.tooltip).to.include('Status: blocked');
            expect(result.tooltip).to.include('⚠️ Waiting for user confirmation');
        });

        it('localizes description when agent is blocked in non-English locale', () => {
            const agent: ParsedAgent = {
                id: 'w1:p1',
                name: 'claude',
                status: 'blocked',
                statusType: 'blocked',
                statusIcon: '🔴',
                isWorking: false,
                isBlocked: true,
                workspaceId: 'w1',
                workspaceLabel: 'herdr-collie'
            };

            l10n.config({
                contents: {
                    'Input Needed': '入力待ち'
                }
            });

            try {
                const result = formatAgentDisplay(agent);
                expect(result.description).to.equal('入力待ち • herdr-collie');
            } finally {
                l10n.config({ contents: {} });
            }
        });

        it('handles agent without resolved workspaceLabel gracefully using workspaceId', () => {
            const agent: ParsedAgent = {
                id: 'w9:p1',
                name: 'w9:p1',
                status: 'working',
                statusType: 'working',
                statusIcon: '🟢',
                isWorking: true,
                isBlocked: false,
                workspaceId: 'w9'
            };

            const result = formatAgentDisplay(agent);
            expect(result.label).to.equal('🟢 Agent');
            expect(result.description).to.equal('Workspace w9');
            expect(result.tooltip).to.include('Workspace: Workspace w9');
            expect(result.tooltip).to.include('Status: working');
        });

        it('handles agent without workspaceId or label', () => {
            const agent: ParsedAgent = {
                id: 'orphan-1',
                name: 'orphan-1',
                status: 'idle',
                statusType: 'idle',
                statusIcon: '🟡',
                isWorking: false,
                isBlocked: false
            };

            const result = formatAgentDisplay(agent);
            expect(result.label).to.equal('🟡 Agent');
            expect(result.description).to.equal('(orphan-1)');
            expect(result.tooltip).to.include('Workspace: Unknown');
        });
    });

    describe('formatWorkspaceDisplay', () => {
        it('formats standard workspace with path and idle status', () => {
            const ws: ParsedWorkspace = {
                id: 'ws-1',
                label: 'main-app',
                cwd: '/path/to/main-app',
                focused: false
            };

            const result = formatWorkspaceDisplay(ws);
            expect(result.label).to.equal('main-app');
            expect(result.isFocused).to.be.false;
            expect(result.isWorktree).to.be.false;
            expect(result.iconId).to.equal('window');
            expect(result.description).to.equal('/path/to/main-app');
            expect(result.tooltip).to.include('Workspace: main-app');
            expect(result.tooltip).to.include('Path: /path/to/main-app');
            expect(result.tooltip).to.include('Workspace ID: ws-1');
            expect(result.tooltip).to.include('Active Agents: (None)');
        });

        it('formats focused workspace with clean window icon and concise description', () => {
            const ws: ParsedWorkspace = {
                id: 'ws-2',
                label: 'api-service',
                cwd: '/path/to/api',
                focused: true
            };

            const result = formatWorkspaceDisplay(ws);
            expect(result.label).to.equal('api-service');
            expect(result.isFocused).to.be.true;
            expect(result.iconId).to.equal('window');
            expect(result.description).to.not.include('[Active in Herdr]');
            expect(result.tooltip).to.include('(Active in Herdr)');
        });

        it('formats Git worktree workspace with git-branch icon and (branch) description', () => {
            const ws: ParsedWorkspace = {
                id: 'ws-wt',
                label: 'feat-auth',
                cwd: '/path/to/feat-auth',
                focused: true
            };

            const worktrees: GitWorktreeInfo[] = [
                {
                    worktree: '/path/to/feat-auth',
                    head: 'c1d2e3f',
                    branch: 'feat/auth'
                }
            ];

            const result = formatWorkspaceDisplay(ws, worktrees);
            expect(result.label).to.equal('feat-auth');
            expect(result.isWorktree).to.be.true;
            expect(result.branchName).to.equal('feat/auth');
            expect(result.iconId).to.equal('git-branch');
            expect(result.description).to.equal('(feat/auth)');
            expect(result.tooltip).to.include('Branch: feat/auth (Git Worktree)');
            expect(result.tooltip).to.include('(Active in Herdr)');
        });

        it('matches current VS Code window folder and assigns folder-active icon', () => {
            const ws: ParsedWorkspace = {
                id: 'ws-local',
                label: 'my-project',
                cwd: '/path/to/current-project',
                focused: false
            };

            const result = formatWorkspaceDisplay(ws, [], [], '/path/to/current-project');
            expect(result.isCurrentWindow).to.be.true;
            expect(result.iconId).to.equal('folder-active');
            expect(result.description).to.not.include('[Current Window]');
            expect(result.tooltip).to.include('VS Code Window: Matches current open folder');
        });

        it('includes associated active agents in description and tooltip without text truncation', () => {
            const ws: ParsedWorkspace = {
                id: 'ws-agents',
                label: 'swarm-hub',
                cwd: '/path/to/hub',
                focused: true
            };

            const agents: ParsedAgent[] = [
                {
                    id: 'pane-1',
                    name: 'claude',
                    status: 'running',
                    statusType: 'working',
                    statusIcon: '🟢',
                    isWorking: true,
                    isBlocked: false,
                    workspaceId: 'ws-agents'
                },
                {
                    id: 'pane-2',
                    name: 'helper',
                    status: 'blocked',
                    statusType: 'blocked',
                    statusIcon: '🔴',
                    isWorking: false,
                    isBlocked: true,
                    workspaceId: 'ws-agents'
                }
            ];

            const result = formatWorkspaceDisplay(ws, [], agents);
            expect(result.matchedAgents).to.have.lengthOf(2);
            expect(result.agentBadges).to.equal('claude 🟢, helper 🔴');
            expect(result.description).to.equal('[claude 🟢, helper 🔴]');
            expect(result.tooltip).to.include('Active Agents (2):');
            expect(result.tooltip).to.include('- 🟢 claude (running)');
            expect(result.tooltip).to.include('- 🔴 helper (blocked)');
        });

        it('aggregates agent badges by status count prioritizing urgency when 3 or more agents exist', () => {
            const ws: ParsedWorkspace = {
                id: 'ws-swarm',
                label: 'swarm-hub',
                cwd: '/path/to/hub',
                focused: false
            };

            const agents: ParsedAgent[] = [
                {
                    id: 'pane-1',
                    name: 'claude',
                    status: 'running',
                    statusType: 'working',
                    statusIcon: '🟢',
                    isWorking: true,
                    isBlocked: false,
                    workspaceId: 'ws-swarm'
                },
                {
                    id: 'pane-2',
                    name: 'cursor',
                    status: 'running',
                    statusType: 'working',
                    statusIcon: '🟢',
                    isWorking: true,
                    isBlocked: false,
                    workspaceId: 'ws-swarm'
                },
                {
                    id: 'pane-3',
                    name: 'helper',
                    status: 'blocked',
                    statusType: 'blocked',
                    statusIcon: '🔴',
                    isWorking: false,
                    isBlocked: true,
                    workspaceId: 'ws-swarm'
                },
                {
                    id: 'pane-4',
                    name: 'monitor',
                    status: 'idle',
                    statusType: 'idle',
                    statusIcon: '🟡',
                    isWorking: false,
                    isBlocked: false,
                    workspaceId: 'ws-swarm'
                }
            ];

            const result = formatWorkspaceDisplay(ws, [], agents);
            expect(result.matchedAgents).to.have.lengthOf(4);
            expect(result.agentBadges).to.equal('🔴 1, 🟢 2, 🟡 1');
            expect(result.description).to.equal('[🔴 1, 🟢 2, 🟡 1]');
            expect(result.tooltip).to.include('Active Agents (4):');
        });
    });

    describe('sortAgents', () => {
        const sampleAgents: ParsedAgent[] = [
            {
                id: 'w2:p1',
                name: 'done-agent',
                status: 'done',
                statusType: 'done',
                statusIcon: '⚪',
                isWorking: false,
                isBlocked: false,
                workspaceId: 'w2',
                workspaceLabel: 'repo-b'
            },
            {
                id: 'w1:p1',
                name: 'idle-agent',
                status: 'idle',
                statusType: 'idle',
                statusIcon: '🟡',
                isWorking: false,
                isBlocked: false,
                workspaceId: 'w1',
                workspaceLabel: 'repo-a'
            },
            {
                id: 'w3:p1',
                name: 'blocked-agent',
                status: 'blocked',
                statusType: 'blocked',
                statusIcon: '🔴',
                isWorking: false,
                isBlocked: true,
                workspaceId: 'w3',
                workspaceLabel: 'repo-c'
            },
            {
                id: 'w1:p2',
                name: 'working-agent',
                status: 'working',
                statusType: 'working',
                statusIcon: '🟢',
                isWorking: true,
                isBlocked: false,
                workspaceId: 'w1',
                workspaceLabel: 'repo-a'
            }
        ];

        it('sorts agents in "grouped" mode by workspace label then pane id', () => {
            const result = sortAgents(sampleAgents, 'grouped');
            // repo-a (w1:p1, w1:p2) -> repo-b (w2:p1) -> repo-c (w3:p1)
            expect(result.map(a => a.id)).to.deep.equal(['w1:p1', 'w1:p2', 'w2:p1', 'w3:p1']);
        });

        it('sorts agents in "priority" mode by urgency (blocked -> working -> idle -> done)', () => {
            const result = sortAgents(sampleAgents, 'priority');
            // blocked (w3:p1) -> working (w1:p2) -> idle (w1:p1) -> done (w2:p1)
            expect(result.map(a => a.id)).to.deep.equal(['w3:p1', 'w1:p2', 'w1:p1', 'w2:p1']);
        });

        it('preserves non-mutating copy of input array', () => {
            const copy = [...sampleAgents];
            sortAgents(sampleAgents, 'priority');
            expect(sampleAgents.map(a => a.id)).to.deep.equal(copy.map(a => a.id));
        });
    });

    describe('formatCodeFence (Prompt Injection & Breakout Prevention)', () => {
        it('uses standard 3 backticks when content does not contain backticks', () => {
            const result = formatCodeFence('const a = 1;', 'ts');
            expect(result).to.equal('```ts\nconst a = 1;\n```');
        });

        it('expands to 4 backticks when content contains 3 backticks', () => {
            const maliciousCode = '```\nconsole.log("breakout");\n```';
            const result = formatCodeFence(maliciousCode, 'javascript');
            expect(result.startsWith('````javascript\n')).to.be.true;
            expect(result.endsWith('\n````')).to.be.true;
            expect(result).to.equal('````javascript\n```\nconsole.log("breakout");\n```\n````');
        });

        it('expands to 6 backticks when content contains 5 consecutive backticks', () => {
            const nestedFences = '`````markdown\ninner code\n`````';
            const result = formatCodeFence(nestedFences);
            expect(result.startsWith('``````\n')).to.be.true;
            expect(result.endsWith('\n``````')).to.be.true;
        });

        it('handles formatSelectionContext with backtick breakout attempts', () => {
            const breakoutSnippet = 'const x = "```";\nconsole.log(x);';
            const result = formatSelectionContext('src/inject.ts', 1, 2, 'typescript', breakoutSnippet);
            expect(result.startsWith('`src/inject.ts` (Lines 1-2):\n````typescript\n')).to.be.true;
            expect(result.endsWith('\n````')).to.be.true;
        });
    });
});


