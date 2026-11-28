/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import '../helpers/mockVscode';
import { resetMockState, mockState, mockVscode, MockUri, MockRange, MockDiagnostic, MockDiagnosticSeverity } from '../helpers/mockVscode';
import { classifyAgentStatus, parseAgents } from '../../parsers';
import {
    AgentHUD,
    escapeMarkdownTableCell,
    collectWorkspaceErrorsForAgent,
    formatAutoVerifyDiagnosticsPrompt
} from '../../agentHUD';
import { HerdrSocketClient } from '../../socketClient';

describe('AgentHUD & Status Classification Unit Tests', () => {
    beforeEach(() => {
        resetMockState();
    });
    describe('classifyAgentStatus', () => {
        it('classifies working/running states', () => {
            const r1 = classifyAgentStatus('running');
            expect(r1.statusType).to.equal('working');
            expect(r1.isWorking).to.be.true;
            expect(r1.isBlocked).to.be.false;
            expect(r1.statusIcon).to.equal('🟢');

            const r2 = classifyAgentStatus('executing');
            expect(r2.statusType).to.equal('working');
            expect(r2.isWorking).to.be.true;
        });

        it('classifies blocked/waiting/needs_input states', () => {
            const r1 = classifyAgentStatus('blocked');
            expect(r1.statusType).to.equal('blocked');
            expect(r1.isBlocked).to.be.true;
            expect(r1.isWorking).to.be.false;
            expect(r1.statusIcon).to.equal('🔴');

            const r2 = classifyAgentStatus('needs_input');
            expect(r2.statusType).to.equal('blocked');
            expect(r2.isBlocked).to.be.true;

            const r3 = classifyAgentStatus('waiting');
            expect(r3.statusType).to.equal('blocked');
            expect(r3.isBlocked).to.be.true;
        });

        it('classifies done/completed states', () => {
            const r1 = classifyAgentStatus('done');
            expect(r1.statusType).to.equal('done');
            expect(r1.statusIcon).to.equal('⚪');
            expect(r1.isWorking).to.be.false;
            expect(r1.isBlocked).to.be.false;

            const r2 = classifyAgentStatus('completed');
            expect(r2.statusType).to.equal('done');
        });

        it('defaults unknown/idle states to idle', () => {
            const r1 = classifyAgentStatus('idle');
            expect(r1.statusType).to.equal('idle');
            expect(r1.statusIcon).to.equal('🟡');
            expect(r1.isWorking).to.be.false;
            expect(r1.isBlocked).to.be.false;

            const r2 = classifyAgentStatus('some_random_state');
            expect(r2.statusType).to.equal('idle');
            expect(r2.statusIcon).to.equal('🟡');
        });
    });

    describe('escapeMarkdownTableCell', () => {
        it('replaces newlines and carriage returns with spaces', () => {
            const input = 'Agent\nLine 2\r\nLine 3';
            expect(escapeMarkdownTableCell(input)).to.equal('Agent Line 2 Line 3');
        });

        it('escapes pipes and backslashes to preserve markdown table formatting', () => {
            const input = 'Worker | Injected | Cell';
            expect(escapeMarkdownTableCell(input)).to.equal('Worker \\| Injected \\| Cell');

            const backslashInput = 'Worker \\ Subpath | Injected';
            expect(escapeMarkdownTableCell(backslashInput)).to.equal('Worker \\\\ Subpath \\| Injected');
        });

        it('sanitizes backticks and brackets', () => {
            const input = '`Dangerous` [Click](command:action)';
            expect(escapeMarkdownTableCell(input)).to.equal("'Dangerous' Click(command:action)");
        });

        it('handles empty and whitespace strings gracefully', () => {
            expect(escapeMarkdownTableCell('')).to.equal('-');
            expect(escapeMarkdownTableCell('   ')).to.equal('-');
            expect(escapeMarkdownTableCell(undefined as any)).to.equal('-');
        });
    });

    describe('Socket Event Listener Lifecycle', () => {
        it('cleans up old socket listeners on updateSocketClient and dispose', () => {
            const registeredListeners: { [event: string]: Function[] } = {};
            const removedListeners: { [event: string]: Function[] } = {};

            const client1: any = {
                on: (event: string, fn: Function) => {
                    registeredListeners[event] = registeredListeners[event] || [];
                    registeredListeners[event].push(fn);
                },
                off: (event: string, fn: Function) => {
                    removedListeners[event] = removedListeners[event] || [];
                    removedListeners[event].push(fn);
                },
                getSnapshot: async () => null,
                isConnected: false
            };

            const client2: any = {
                on: () => {},
                off: () => {},
                getSnapshot: async () => null,
                isConnected: false
            };

            const hud = new AgentHUD(client1 as unknown as HerdrSocketClient, () => 'default');
            expect(registeredListeners['connect']).to.have.lengthOf(1);
            expect(registeredListeners['event']).to.have.lengthOf(1);
            expect(registeredListeners['disconnect']).to.have.lengthOf(1);
            expect(registeredListeners['error']).to.have.lengthOf(1);

            // Update to new client without triggering immediate refresh
            let c2SnapshotCalls = 0;
            client2.getSnapshot = async () => {
                c2SnapshotCalls++;
                return null;
            };
            hud.updateSocketClient(client2 as unknown as HerdrSocketClient, { refresh: false });
            expect(removedListeners['connect']).to.have.lengthOf(1);
            expect(removedListeners['event']).to.have.lengthOf(1);
            expect(removedListeners['disconnect']).to.have.lengthOf(1);
            expect(removedListeners['error']).to.have.lengthOf(1);
            expect(c2SnapshotCalls).to.equal(0);

            // Dispose
            hud.dispose();
        });
    });

    describe('Closed-Loop Diagnostics Verification (collectWorkspaceErrorsForAgent & formatAutoVerifyDiagnosticsPrompt)', () => {
        it('returns empty summary when no diagnostics exist', () => {
            const summary = collectWorkspaceErrorsForAgent();
            expect(summary.totalErrors).to.equal(0);
            expect(summary.fileCount).to.equal(0);
            expect(summary.problemsByFile).to.deep.equal({});
            expect(formatAutoVerifyDiagnosticsPrompt(summary)).to.equal('');
        });

        it('collects only Error-severity diagnostics and ignores Warnings/Hints', () => {
            const uri = MockUri.file('/workspace/app/src/index.ts');
            const errDiag = new MockDiagnostic(new MockRange(9, 0, 9, 10), "Cannot find name 'foo'.", MockDiagnosticSeverity.Error);
            const warnDiag = new MockDiagnostic(new MockRange(14, 0, 14, 5), 'Unused variable.', MockDiagnosticSeverity.Warning);
            const hintDiag = new MockDiagnostic(new MockRange(20, 0, 20, 5), 'Convert to const.', MockDiagnosticSeverity.Hint);

            mockState.workspaceDiagnostics = [[uri, [errDiag, warnDiag, hintDiag]]];

            const summary = collectWorkspaceErrorsForAgent('/workspace/app');
            expect(summary.totalErrors).to.equal(1);
            expect(summary.fileCount).to.equal(1);
            expect(summary.problemsByFile['src/index.ts']).to.deep.equal([
                { line: 10, severity: 'Error', message: "Cannot find name 'foo'." }
            ]);
        });

        it('scopes diagnostics to agent workspace CWD and excludes other worktrees', () => {
            const wtAUri = MockUri.file('/workspace/repo-wt-a/src/auth.ts');
            const wtBUri = MockUri.file('/workspace/repo-wt-b/src/billing.ts');
            const untitledUri = { scheme: 'untitled', fsPath: 'Untitled-1', path: 'Untitled-1' };

            mockState.workspaceDiagnostics = [
                [wtAUri, [new MockDiagnostic(new MockRange(4, 0, 4, 8), 'Type error in auth', MockDiagnosticSeverity.Error)]],
                [wtBUri, [new MockDiagnostic(new MockRange(11, 0, 11, 8), 'Type error in billing', MockDiagnosticSeverity.Error)]],
                [untitledUri, [new MockDiagnostic(new MockRange(0, 0, 0, 5), 'Untitled error', MockDiagnosticSeverity.Error)]]
            ];

            const summaryA = collectWorkspaceErrorsForAgent('/workspace/repo-wt-a');
            expect(summaryA.totalErrors).to.equal(1);
            expect(summaryA.fileCount).to.equal(1);
            expect(summaryA.problemsByFile).to.have.property('src/auth.ts');
            expect(summaryA.problemsByFile).to.not.have.property('src/billing.ts');
            expect(summaryA.problemsByFile).to.not.have.property('Untitled-1');

            const unscopedSummary = collectWorkspaceErrorsForAgent(undefined);
            expect(unscopedSummary.totalErrors).to.equal(2);
            expect(Object.keys(unscopedSummary.problemsByFile)).to.not.include('Untitled-1');
        });

        it('formats auto-verify prompt with loop iteration header when attempt and maxRetries are provided', () => {
            const uri = MockUri.file('/workspace/app/src/calc.ts');
            mockState.workspaceDiagnostics = [
                [uri, [new MockDiagnostic(new MockRange(2, 0, 2, 5), 'Expected 2 arguments, but got 1.', MockDiagnosticSeverity.Error)]]
            ];

            const summary = collectWorkspaceErrorsForAgent('/workspace/app');
            const promptPromptMode = formatAutoVerifyDiagnosticsPrompt(summary);
            expect(promptPromptMode).to.include('### `src/calc.ts`');
            expect(promptPromptMode).to.include('**Line 3** [Error]: Expected 2 arguments, but got 1.');
            expect(promptPromptMode).to.not.include('[Auto-Verify Loop');

            const promptAutoMode = formatAutoVerifyDiagnosticsPrompt(summary, 1, 2);
            expect(promptAutoMode).to.include('[Auto-Verify Loop 1/2]');
            expect(promptAutoMode).to.include('### `src/calc.ts`');
        });
    });

    describe('Agent Time-in-State & Latest Output Enrichment', () => {
        it('retains statusChangedAt across refreshes when statusType does not change and resets on transition', async () => {
            let currentSnapshot: any = {
                agents: [
                    { pane_id: 'w1:p1', name: 'claude', agent_status: 'working', last_output: 'Step 1: analyzing' }
                ]
            };
            const client: any = {
                on: () => {},
                off: () => {},
                isConnected: true,
                getSnapshot: async () => currentSnapshot
            };

            const hud = new AgentHUD(client as unknown as HerdrSocketClient, () => 'default');
            await hud.refresh();

            const enriched1 = hud.enrichAgentsWithStateMetadata([
                {
                    id: 'w1:p1',
                    name: 'claude',
                    status: 'working',
                    statusType: 'working',
                    statusIcon: '🟢',
                    isWorking: true,
                    isBlocked: false
                }
            ]);
            expect(enriched1[0].statusChangedAt).to.be.a('number');
            expect(enriched1[0].latestOutput).to.equal('Step 1: analyzing');

            const firstTimestamp = enriched1[0].statusChangedAt!;
            await new Promise(r => setTimeout(r, 15));

            // Refresh with same statusType ('working') -> timestamp should be preserved
            await hud.refresh();
            const enriched2 = hud.enrichAgentsWithStateMetadata([
                {
                    id: 'w1:p1',
                    name: 'claude',
                    status: 'working',
                    statusType: 'working',
                    statusIcon: '🟢',
                    isWorking: true,
                    isBlocked: false
                }
            ]);
            expect(enriched2[0].statusChangedAt).to.equal(firstTimestamp);

            // Transition to 'blocked' with new output -> timestamp updates and notification includes latest output
            currentSnapshot = {
                agents: [
                    { pane_id: 'w1:p1', name: 'claude', agent_status: 'blocked', last_output: 'Allow rm -rf dist? (y/n)' }
                ]
            };
            await hud.refresh();
            const enriched3 = hud.enrichAgentsWithStateMetadata([
                {
                    id: 'w1:p1',
                    name: 'claude',
                    status: 'blocked',
                    statusType: 'blocked',
                    statusIcon: '🔴',
                    isWorking: false,
                    isBlocked: true
                }
            ]);
            expect(enriched3[0].statusChangedAt).to.be.greaterThan(firstTimestamp);
            expect(enriched3[0].latestOutput).to.equal('Allow rm -rf dist? (y/n)');
            expect(mockState.lastWarningMessage?.message).to.include("Agent 'claude' requires input / confirmation");
            expect(mockState.lastWarningMessage?.message).to.include('Allow rm -rf dist? (y/n)');

            hud.dispose();
        });

        it('coalesces bursty socket event refreshes into a single getSnapshot call', async () => {
            const { EventEmitter } = require('events');
            const emitterClient: any = new EventEmitter();
            emitterClient.isConnected = true;
            let snapshotCalls = 0;
            const recordedMaxAges: number[] = [];
            emitterClient.getSnapshot = async (maxAgeMs: number = 0) => {
                snapshotCalls++;
                recordedMaxAges.push(maxAgeMs);
                return { agents: [{ pane_id: 'w1:p1', name: 'claude', agent_status: 'working' }] };
            };

            const hud = new AgentHUD(emitterClient as unknown as HerdrSocketClient, () => 'test-session');
            emitterClient.emit('event', { type: 'pane.output' });
            emitterClient.emit('event', { type: 'pane.output' });
            emitterClient.emit('event', { type: 'pane.output' });

            await new Promise(r => setTimeout(r, 70));
            expect(snapshotCalls).to.equal(1);
            expect(recordedMaxAges).to.deep.equal([150]);

            // Direct explicit refresh() must bypass short-lived cache (maxAgeMs = 0)
            await hud.refresh();
            expect(snapshotCalls).to.equal(2);
            expect(recordedMaxAges[1]).to.equal(0);

            hud.dispose();
        });

        it('clears prior session tracking state on updateSocketClient so same pane IDs do not misfire', async () => {
            mockState.configurations.set('herdr-collie.agentHUD.enableNotifications', true);

            const makeClient = (agents: any[]) => ({
                on: () => {},
                off: () => {},
                isConnected: true,
                getSnapshot: async () => ({ agents })
            }) as unknown as HerdrSocketClient;

            const sessionAClient = makeClient([
                { pane_id: 'w1:p1', name: 'claude-a', agent_status: 'working' }
            ]);
            const sessionBClient = makeClient([
                { pane_id: 'w1:p1', name: 'claude-b', agent_status: 'done' }
            ]);

            const hud = new AgentHUD(sessionAClient, () => 'session-a');
            try {
                await hud.refresh();
                expect(mockState.lastInformationMessage).to.be.undefined;

                // Switch to session B where pane w1:p1 is already done; must NOT fire completion notification from session A's working state
                hud.updateSocketClient(sessionBClient);
                await hud.refresh();
                expect(mockState.lastInformationMessage).to.be.undefined;
                expect((mockState.statusBarItems[0] as any)?.accessibilityInformation?.label).to.be.a('string');
            } finally {
                hud.dispose();
            }
        });

        it('drops stale in-flight refresh results that resolve after updateSocketClient()', async () => {
            let resolveStale!: (val: any) => void;
            const stalePromise = new Promise(resolve => { resolveStale = resolve; });

            const staleClient: any = {
                on: () => {},
                off: () => {},
                isConnected: true,
                getSnapshot: () => stalePromise
            };
            const freshClient: any = {
                on: () => {},
                off: () => {},
                isConnected: true,
                getSnapshot: async () => ({ agents: [] })
            };

            const hud = new AgentHUD(staleClient as unknown as HerdrSocketClient, () => 'session-a');
            try {
                const inflight = hud.refresh();
                // While session-a snapshot is still pending, switch to session-b and settle session-b
                hud.updateSocketClient(freshClient as unknown as HerdrSocketClient, { refresh: true });
                await new Promise(r => setTimeout(r, 20));
                const textAfterFresh = mockState.statusBarItems[0].text;

                // Now resolve stale session-a response with a blocked agent -> must be ignored
                resolveStale({ agents: [{ pane_id: 'stale:p1', name: 'stale-bot', agent_status: 'blocked' }] });
                await inflight;

                expect(mockState.statusBarItems[0].text).to.equal(textAfterFresh);
                expect(mockState.statusBarItems[0].text).to.not.include('stale-bot');
            } finally {
                hud.dispose();
            }
        });

        it('ignores notification action if active session changed while notification was open', async () => {
            let resolveWarn!: (choice: string | undefined) => void;
            const origShowWarning = mockVscode.window.showWarningMessage;
            (mockVscode.window as any).showWarningMessage = async (msg: string, ...items: any[]) => {
                mockState.lastWarningMessage = { message: msg, items };
                if (msg.includes('requires input')) {
                    return await new Promise<string | undefined>(resolve => {
                        resolveWarn = resolve;
                    });
                }
                return undefined;
            };

            let currentSession = 'session-a';
            let sentKeysCalls = 0;
            const clientA: any = {
                on: () => {},
                off: () => {},
                isConnected: true,
                sendPaneKeys: async () => { sentKeysCalls++; },
                getSnapshot: async () => ({
                    agents: [{ pane_id: '0:0', name: 'claude-a', agent_status: 'blocked' }]
                })
            };
            const clientB: any = {
                on: () => {},
                off: () => {},
                isConnected: true,
                sendPaneKeys: async () => { sentKeysCalls++; },
                getSnapshot: async () => ({ agents: [] })
            };

            const hud = new AgentHUD(clientA as unknown as HerdrSocketClient, () => currentSession);
            try {
                await hud.refresh();
                // User switches to session-b while blocked notification for session-a is open
                currentSession = 'session-b';
                hud.updateSocketClient(clientB as unknown as HerdrSocketClient, { refresh: false });

                resolveWarn('Approve (y)');
                await new Promise(r => setTimeout(r, 20));

                expect(sentKeysCalls).to.equal(0);
                expect(mockState.lastWarningMessage?.message).to.include('Ignored action');
            } finally {
                mockVscode.window.showWarningMessage = origShowWarning;
                hud.dispose();
            }
        });

        it('falls back to CLI agent list in showHUDQuickPick() when disconnected and guards QuickPick actions on session switch', async () => {
            const cp = require('child_process');
            const origExecFile = cp.execFile;
            const origCreateQuickPick = mockVscode.window.createQuickPick;

            (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
                const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
                if (args.includes('agent') && args.includes('list')) {
                    callback?.(null, JSON.stringify({
                        agents: [{ pane_id: '0:0', name: 'cli-agent', status: 'blocked', workspace_id: 'w1' }]
                    }), '');
                    return {} as any;
                }
                callback?.(null, '', '');
                return {} as any;
            };

            let triggerBtnHandler: ((e: any) => Promise<void>) | undefined;
            let qpItems: any[] = [];
            (mockVscode.window as any).createQuickPick = () => ({
                title: '',
                placeholder: '',
                set items(val: any[]) { qpItems = val; },
                get items() { return qpItems; },
                selectedItems: [],
                onDidTriggerItemButton: (cb: any) => { triggerBtnHandler = cb; return { dispose: () => {} }; },
                onDidAccept: () => ({ dispose: () => {} }),
                onDidHide: () => ({ dispose: () => {} }),
                show: () => {},
                hide: () => {},
                dispose: () => {}
            });

            let currentSession = 'session-a';
            let sentKeysCalls = 0;
            const disconnectedClient: any = {
                on: () => {},
                off: () => {},
                isConnected: false,
                sendPaneKeys: async () => { sentKeysCalls++; },
                getSnapshot: async () => null
            };
            const clientB: any = { ...disconnectedClient };

            const hud = new AgentHUD(disconnectedClient as unknown as HerdrSocketClient, () => currentSession);
            try {
                await hud.showHUDQuickPick();
                expect(qpItems).to.have.lengthOf(1);
                expect(qpItems[0].agent.name).to.equal('cli-agent');

                // Switch session while QuickPick is open, then click Quick Approve (y) -> must be ignored cleanly
                currentSession = 'session-b';
                hud.updateSocketClient(clientB as unknown as HerdrSocketClient, { refresh: false });
                await triggerBtnHandler?.({
                    item: qpItems[0],
                    button: qpItems[0].buttons.find((b: any) => String(b.tooltip).includes('Quick Approve'))
                });
                expect(sentKeysCalls).to.equal(0);
                expect(mockState.lastWarningMessage?.message).to.include('Ignored action');
            } finally {
                cp.execFile = origExecFile;
                (mockVscode.window as any).createQuickPick = origCreateQuickPick;
                hud.dispose();
            }
        });

        it('awaits CLI sendKeysToAgent errors and reports failure instead of false success notification', async () => {
            const cp = require('child_process');
            const origExecFile = cp.execFile;
            const origShowError = (mockVscode.window as any).showErrorMessage;
            const errorsShown: string[] = [];
            (mockVscode.window as any).showErrorMessage = async (msg: string) => {
                errorsShown.push(msg);
                return undefined;
            };

            (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
                const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
                if (args.includes('send-keys')) {
                    callback?.(new Error('pane gone'), '', 'pane gone');
                    return {} as any;
                }
                callback?.(null, '', '');
                return {} as any;
            };

            const disconnectedClient: any = {
                on: () => {},
                off: () => {},
                isConnected: false,
                getSnapshot: async () => null
            };
            const hud = new AgentHUD(disconnectedClient as unknown as HerdrSocketClient, () => 'vscode');
            try {
                mockState.warningMessageResponse = 'Approve (y)';
                await (hud as any).triggerBlockedNotification({
                    id: 'w1:p1',
                    name: 'claude',
                    status: 'blocked',
                    statusType: 'blocked',
                    statusIcon: '🔴',
                    isWorking: false,
                    isBlocked: true
                });
                expect(errorsShown.some(m => m.includes("Failed to send input to 'claude'"))).to.be.true;
                expect(mockState.lastInformationMessage).to.be.undefined;
            } finally {
                cp.execFile = origExecFile;
                (mockVscode.window as any).showErrorMessage = origShowError;
                hud.dispose();
            }
        });

        it('populates workspaceCwd in AgentHUD CLI fallback without daemon auto-start and isolates auto-verify when workspaceCwd is missing', async () => {
            const cp = require('child_process');
            const origExecFile = cp.execFile;
            const origSpawn = cp.spawn;
            const execCalls: string[][] = [];
            let spawnCalls = 0;

            (cp as any).spawn = () => {
                spawnCalls++;
                return { unref: () => {}, on: () => {} } as any;
            };
            (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
                execCalls.push(args);
                const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
                if (args.includes('workspace') && args.includes('list')) {
                    callback?.(null, JSON.stringify({ workspaces: [{ workspace_id: 'w1', label: 'wt-a' }] }), '');
                    return {} as any;
                }
                if (args.includes('pane') && args.includes('list')) {
                    callback?.(null, JSON.stringify({ panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', foreground_cwd: '/workspace/repo-wt-a' }] }), '');
                    return {} as any;
                }
                if (args.includes('agent') && args.includes('list')) {
                    callback?.(null, JSON.stringify({ agents: [{ pane_id: 'w1:p1', name: 'cli-agent', status: 'running', workspace_id: 'w1' }] }), '');
                    return {} as any;
                }
                callback?.(new Error('server_not_running'), '', 'error: server_not_running');
                return {} as any;
            };

            const disconnectedClient: any = {
                on: () => {},
                off: () => {},
                isConnected: false,
                getSnapshot: async () => null
            };
            const hud = new AgentHUD(disconnectedClient as unknown as HerdrSocketClient, () => 'vscode');
            try {
                // Direct parser fallback with explicit agent CWD
                const directParsed = parseAgents(JSON.stringify({
                    agents: [{ pane_id: 'w9:p1', name: 'direct', status: 'idle', workspace_cwd: '/workspace/direct-wt' }]
                }));
                expect(directParsed[0].workspaceCwd).to.equal('/workspace/direct-wt');

                // CLI fallback resolves workspaceCwd via workspace + pane lists and skips auto-start on errors
                const resolvedAgents = await (hud as any).fetchAgentsWithCliFallback();
                expect(execCalls.some(a => a.includes('workspace') && a.includes('list'))).to.be.true;
                expect(execCalls.some(a => a.includes('pane') && a.includes('list'))).to.be.true;
                expect(execCalls.some(a => a.includes('agent') && a.includes('list'))).to.be.true;
                expect(spawnCalls).to.equal(0);
                expect(resolvedAgents[0].workspaceCwd).to.equal('/workspace/repo-wt-a');

                // Auto-verify must NOT dispatch diagnostics from another worktree when agent.workspaceCwd is undefined
                mockState.configurations.set('herdr-collie.agentHUD.autoVerifyDiagnostics', 'auto');
                mockState.workspaceDiagnostics = [
                    [MockUri.file('/workspace/other-wt/src/broken.ts'), [new MockDiagnostic(new MockRange(0, 0, 0, 5), 'Other worktree error', MockDiagnosticSeverity.Error)]]
                ];
                let sentPrompts = 0;
                const noCwdSocket: any = {
                    on: () => {},
                    off: () => {},
                    isConnected: true,
                    sendAgentPrompt: async () => { sentPrompts++; },
                    getSnapshot: async () => ({
                        workspaces: [{ workspace_id: 'w-no-cwd', label: 'NoCwd' }],
                        agents: []
                    })
                };
                const hudNoCwd = new AgentHUD(noCwdSocket as unknown as HerdrSocketClient, () => 'vscode');
                try {
                    noCwdSocket.getSnapshot = async () => ({
                        workspaces: [{ workspace_id: 'w-no-cwd', label: 'NoCwd' }],
                        agents: [{ pane_id: 'w-no-cwd:p1', name: 'isolated-agent', agent_status: 'running', workspace_id: 'w-no-cwd' }]
                    });
                    await hudNoCwd.refresh();
                    noCwdSocket.getSnapshot = async () => ({
                        workspaces: [{ workspace_id: 'w-no-cwd', label: 'NoCwd' }],
                        agents: [{ pane_id: 'w-no-cwd:p1', name: 'isolated-agent', agent_status: 'done', workspace_id: 'w-no-cwd' }]
                    });
                    await hudNoCwd.refresh();
                    await new Promise(r => setTimeout(r, 30));

                    expect(sentPrompts).to.equal(0);
                    expect(hudNoCwd.getAutoVerifyRetryCount('w-no-cwd:p1')).to.equal(0);
                } finally {
                    hudNoCwd.dispose();
                }
            } finally {
                cp.execFile = origExecFile;
                cp.spawn = origSpawn;
                hud.dispose();
            }
        });
    });
});
