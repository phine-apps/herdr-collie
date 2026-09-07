/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import {
    formatSelectionContext,
    formatFileDiagnostics,
    formatWorkspaceProblems,
    formatGitDiff,
    formatBranchContext,
    formatHoverInfo,
    formatTerminalOutput,
    formatAgentDisplay,
    sortAgents
} from '../../formatters';
import { ParsedAgent, GitWorktreeInfo } from '../../parsers';

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
            expect(result.label).to.equal('🟡 [herdr-collie] cursor');
            expect(result.description).to.equal('(w1:p1)');
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
            expect(result.label).to.equal('⚪ [electric-prophet (main)] agy');
            expect(result.description).to.equal('(wD:p1)');
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
            expect(result.label).to.equal('🔴 [herdr-collie] claude');
            expect(result.description).to.equal('⚠️ Input Needed (w1:p2)');
            expect(result.tooltip).to.include('Status: blocked');
            expect(result.tooltip).to.include('⚠️ Waiting for user confirmation');
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
            expect(result.label).to.equal('🟢 [Workspace w9] Agent');
            expect(result.description).to.equal('(w9:p1)');
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
});


