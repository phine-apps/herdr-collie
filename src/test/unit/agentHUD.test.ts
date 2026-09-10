/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import '../helpers/mockVscode';
import { classifyAgentStatus, ParsedAgent } from '../../parsers';
import { AgentHUD, escapeMarkdownTableCell } from '../../agentHUD';
import { HerdrSocketClient } from '../../socketClient';

describe('AgentHUD & Status Classification Unit Tests', () => {
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
});
