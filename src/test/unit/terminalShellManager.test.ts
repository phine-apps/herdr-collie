/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { mockState, resetMockState, mockVscode, MockEventEmitter } from '../helpers/mockVscode';
import { expect } from 'chai';
import {
    stripTerminalControlSequences,
    truncateOutputTail,
    isHerdrManagedTerminal,
    shouldIgnoreExitCode,
    formatFailedCommandPrompt,
    TerminalShellMonitor,
    TerminalPromptDispatchOptions
} from '../../terminalShellManager';

function createAsyncChunks(chunks: string[]): AsyncIterable<string> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const c of chunks) {
                await new Promise(resolve => setTimeout(resolve, 2));
                yield c;
            }
        }
    };
}

describe('terminalShellManager Unit Tests', () => {
    beforeEach(() => {
        resetMockState();
    });

    describe('stripTerminalControlSequences & truncateOutputTail', () => {
        it('strips CSI color codes, OSC 633 shell markers, and normalizes CRLF', () => {
            const raw = '\x1b]633;C\x07\x1b[31mError:\x1b[0m build failed\r\n  at src/app.ts:12\x1b]633;D;1\x07\r\n';
            expect(stripTerminalControlSequences(raw)).to.equal('Error: build failed\n  at src/app.ts:12');
        });

        it('preserves trailing output lines when truncating oversized terminal output', () => {
            const head = 'INFO line '.repeat(200);
            const tail = 'FATAL: TypeScript compilation error TS2304';
            const combined = `${head}\n${tail}`;

            const truncated = truncateOutputTail(combined, 300);
            expect(truncated.length).to.be.at.most(300);
            expect(truncated).to.include('... (earlier output omitted)\n');
            expect(truncated).to.include(tail);
        });
    });

    describe('isHerdrManagedTerminal & shouldIgnoreExitCode', () => {
        it('identifies Herdr-managed TUI terminals accurately', () => {
            expect(isHerdrManagedTerminal({ name: 'Herdr' })).to.be.true;
            expect(isHerdrManagedTerminal({ name: 'Herdr: vscode' })).to.be.true;
            expect(isHerdrManagedTerminal({ name: 'Herdr (default)' })).to.be.true;
            expect(isHerdrManagedTerminal({ name: 'zsh' })).to.be.false;
            expect(isHerdrManagedTerminal({ name: 'vitest' })).to.be.false;
        });

        it('ignores success (0), undefined, Ctrl+C (130), and empty command lines', () => {
            expect(shouldIgnoreExitCode(0, 'pnpm test')).to.be.true;
            expect(shouldIgnoreExitCode(undefined, 'pnpm test')).to.be.true;
            expect(shouldIgnoreExitCode(130, 'pnpm test')).to.be.true;
            expect(shouldIgnoreExitCode(1, '   ')).to.be.true;
            expect(shouldIgnoreExitCode(1, 'pnpm test')).to.be.false;
            expect(shouldIgnoreExitCode(2, 'tsc -p ./')).to.be.false;
        });
    });

    describe('formatFailedCommandPrompt', () => {
        it('formats working directory, command line, exit code, and terminal output cleanly', () => {
            const prompt = formatFailedCommandPrompt({
                id: 'exec-1',
                terminalName: 'zsh',
                commandLine: 'pnpm test',
                cwd: '/repo/wt-feat',
                exitCode: 1,
                output: 'AssertionError: expected 1 to equal 2',
                startedAt: 1000,
                endedAt: 2000,
                failed: true
            });

            expect(prompt).to.include('**Working Directory:** `/repo/wt-feat`');
            expect(prompt).to.include('Here is the terminal output for command `pnpm test` (Terminal: `zsh`):');
            expect(prompt).to.include('**Exit Code:** `1` (Execution failed)');
            expect(prompt).to.include('AssertionError: expected 1 to equal 2');
        });
    });

    describe('TerminalShellMonitor lifecycle & QuickFix dispatch', () => {
        it('subscribes to Shell Integration events, captures output, shows StatusBar QuickFix, and dispatches fix', async () => {
            const startEmitter = new MockEventEmitter<any>();
            const endEmitter = new MockEventEmitter<any>();
            const winAny = mockVscode.window as any;
            const origStart = winAny.onDidStartTerminalShellExecution;
            const origEnd = winAny.onDidEndTerminalShellExecution;
            winAny.onDidStartTerminalShellExecution = startEmitter.event;
            winAny.onDidEndTerminalShellExecution = endEmitter.event;

            const dispatched: Array<{ prompt: string; title: string; options?: TerminalPromptDispatchOptions }> = [];
            const monitor = new TerminalShellMonitor(async (prompt, _successMsg, title, options) => {
                dispatched.push({ prompt, title, options });
                return true;
            });

            try {
                expect(monitor.isShellIntegrationSupported).to.be.true;
                mockState.warningMessageResponse = 'Fix with Herdr Agent';

                const terminal = { name: 'zsh' } as any;
                const execution = {
                    commandLine: { value: 'pnpm run compile' },
                    cwd: mockVscode.Uri.file('/repo/worktree-a'),
                    read: () => createAsyncChunks(['\x1b[31msrc/app.ts(10,5): error TS2322\x1b[0m\r\n'])
                };

                startEmitter.fire({ terminal, execution });
                await monitor.handleExecutionEnd({ terminal, execution, exitCode: 2 });

                // Status bar indicator should be visible with failed command
                const sbItem = mockState.statusBarItems.find(i => i.id === 'herdr-collie.terminalFailure');
                expect(sbItem).to.exist;
                expect(sbItem?.text).to.include('Fix: pnpm run compile (exit 2)');

                // Because warningMessageResponse was 'Fix with Herdr Agent', dispatchPrompt was called immediately
                expect(dispatched).to.have.lengthOf(1);
                expect(dispatched[0].prompt).to.include('src/app.ts(10,5): error TS2322');
                expect(dispatched[0].options?.preferredCwd).to.equal('/repo/worktree-a');
                expect(dispatched[0].options?.stageOnly).to.be.false;

                // After successful dispatch, the failure indicator hides
                expect(sbItem?.visible).to.be.false;
            } finally {
                monitor.dispose();
                winAny.onDidStartTerminalShellExecution = origStart;
                winAny.onDidEndTerminalShellExecution = origEnd;
            }
        });

        it('respects statusbar-only and off modes for terminal.failureAction setting', async () => {
            const dispatched: string[] = [];
            const monitor = new TerminalShellMonitor(async (prompt) => {
                dispatched.push(prompt);
                return true;
            });

            try {
                mockState.configurations.set('herdr-collie.terminal.failureAction', 'statusbar');
                const terminal = { name: 'bash' } as any;
                const execution = {
                    commandLine: { value: 'cargo test' },
                    read: () => createAsyncChunks(['test failed'])
                };

                monitor.handleExecutionStart({ terminal, execution });
                await monitor.handleExecutionEnd({ terminal, execution, exitCode: 1 });

                const sbItem = mockState.statusBarItems.find(i => i.id === 'herdr-collie.terminalFailure');
                expect(sbItem?.visible).to.be.true;
                expect(mockState.lastWarningMessage).to.be.undefined;
                expect(dispatched).to.be.empty;

                // Subsequent exit 0 in the same terminal clears the failure indicator automatically
                const okExec = {
                    commandLine: { value: 'cargo test' },
                    read: () => createAsyncChunks(['test result: ok'])
                };
                monitor.handleExecutionStart({ terminal, execution: okExec });
                await monitor.handleExecutionEnd({ terminal, execution: okExec, exitCode: 0 });
                expect(sbItem?.visible).to.be.false;

                // 'off' mode suppresses both status bar and notification
                mockState.configurations.set('herdr-collie.terminal.failureAction', 'off');
                const exec2 = {
                    commandLine: { value: 'make build' },
                    read: () => createAsyncChunks(['make error'])
                };
                monitor.handleExecutionStart({ terminal, execution: exec2 });
                await monitor.handleExecutionEnd({ terminal, execution: exec2, exitCode: 2 });
                expect(sbItem?.visible).to.be.false;
            } finally {
                monitor.dispose();
            }
        });

        it('skips failure prompts for Herdr-managed terminals and Ctrl+C (exit 130)', async () => {
            const monitor = new TerminalShellMonitor(async () => true);
            try {
                const herdrTerm = { name: 'Herdr: vscode' } as any;
                const exec1 = {
                    commandLine: { value: 'claude' },
                    read: () => createAsyncChunks(['session ended'])
                };
                monitor.handleExecutionStart({ terminal: herdrTerm, execution: exec1 });
                await monitor.handleExecutionEnd({ terminal: herdrTerm, execution: exec1, exitCode: 1 });

                const userTerm = { name: 'zsh' } as any;
                const execCtrlC = {
                    commandLine: { value: 'pnpm watch' },
                    read: () => createAsyncChunks(['^C'])
                };
                monitor.handleExecutionStart({ terminal: userTerm, execution: execCtrlC });
                await monitor.handleExecutionEnd({ terminal: userTerm, execution: execCtrlC, exitCode: 130 });

                expect(mockState.lastWarningMessage).to.be.undefined;
                expect(monitor.getCurrentFailedRecord()).to.be.undefined;
            } finally {
                monitor.dispose();
            }
        });

        it('triggers fallback handler when fixFailedExecutionWizard runs without recorded executions', async () => {
            let fallbackCalled = false;
            const monitor = new TerminalShellMonitor(
                async () => true,
                async () => { fallbackCalled = true; }
            );
            try {
                await monitor.fixFailedExecutionWizard();
                expect(fallbackCalled).to.be.true;
            } finally {
                monitor.dispose();
            }
        });
    });
});
