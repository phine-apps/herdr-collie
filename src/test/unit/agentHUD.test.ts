/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import '../helpers/mockVscode';
import { resetMockState, mockState, MockUri, MockRange, MockDiagnostic, MockDiagnosticSeverity } from '../helpers/mockVscode';
import { classifyAgentStatus } from '../../parsers';
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

            // Update to new client
            hud.updateSocketClient(client2 as unknown as HerdrSocketClient);
            expect(removedListeners['connect']).to.have.lengthOf(1);
            expect(removedListeners['event']).to.have.lengthOf(1);
            expect(removedListeners['disconnect']).to.have.lengthOf(1);

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

            mockState.workspaceDiagnostics = [
                [wtAUri, [new MockDiagnostic(new MockRange(4, 0, 4, 8), 'Type error in auth', MockDiagnosticSeverity.Error)]],
                [wtBUri, [new MockDiagnostic(new MockRange(11, 0, 11, 8), 'Type error in billing', MockDiagnosticSeverity.Error)]]
            ];

            const summaryA = collectWorkspaceErrorsForAgent('/workspace/repo-wt-a');
            expect(summaryA.totalErrors).to.equal(1);
            expect(summaryA.fileCount).to.equal(1);
            expect(summaryA.problemsByFile).to.have.property('src/auth.ts');
            expect(summaryA.problemsByFile).to.not.have.property('src/billing.ts');
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
    });
});
