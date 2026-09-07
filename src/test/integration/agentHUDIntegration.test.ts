/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install mock
import { expect } from 'chai';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { HerdrSocketClient } from '../../socketClient';
import { AgentHUD } from '../../agentHUD';
import { mockState, resetMockState } from '../helpers/mockVscode';

describe('Agent Attention HUD & Real-time Socket Integration Tests (H-01 ~ H-05, H-09, A-01)', function() {
    this.timeout(10000);

    let mockServer: net.Server;
    let tempSockPath: string;
    let activeSockets: Set<net.Socket> = new Set();
    let receivedCommands: any[] = [];
    let currentMockAgents: any[] = [];

    beforeEach((done) => {
        resetMockState();
        receivedCommands = [];
        activeSockets.clear();
        currentMockAgents = [
            { id: 'agent-1', name: 'Claude-Worker', status: 'running' },
            { id: 'agent-2', name: 'Agy-Worker', status: 'idle' }
        ];

        tempSockPath = path.join(os.tmpdir(), `collie-hud-test-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

        mockServer = net.createServer((socket) => {
            activeSockets.add(socket);
            socket.on('close', () => activeSockets.delete(socket));
            socket.on('error', () => {});
            socket.on('data', (data) => {
                const lines = data.toString().split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        receivedCommands.push(msg);
                        if (!socket.destroyed) {
                            if (msg.method === 'events.subscribe') {
                                socket.write(JSON.stringify({ id: msg.id, result: { subscribed: true } }) + '\n');
                            } else if (msg.method === 'session.snapshot') {
                                socket.write(JSON.stringify({
                                    id: msg.id,
                                    result: {
                                        snapshot: {
                                            workspaces: [
                                                { workspace_id: 'ws-1', label: 'Primary', focused: true }
                                            ],
                                            agents: currentMockAgents
                                        }
                                    }
                                }) + '\n');
                            } else if (msg.method === 'pane.send_keys' || msg.method === 'pane.send_text' || msg.method === 'pane.send_input' || msg.method === 'agent.send_keys' || msg.method === 'agent.prompt') {
                                socket.write(JSON.stringify({ id: msg.id, result: { sent: true } }) + '\n');
                            }
                        }
                    } catch (e) {}
                }
            });
        });

        mockServer.listen(tempSockPath, () => done());
    });

    afterEach(async () => {
        for (const sock of activeSockets) {
            try {
                sock.destroy();
            } catch (e) {}
        }
        activeSockets.clear();

        if (mockServer) {
            await new Promise<void>((resolve) => {
                mockServer.close(() => {
                    try {
                        if (fs.existsSync(tempSockPath)) {
                            fs.unlinkSync(tempSockPath);
                        }
                    } catch (e) {}
                    resolve();
                });
            });
        }
    });

    it('updates StatusBar HUD and tooltip when connected and receiving snapshots (H-01, H-02)', async () => {
        const client = new HerdrSocketClient(tempSockPath);
        client.on('error', () => {});
        client.connect();

        const hud = new AgentHUD(client, () => 'test-session');

        // Wait for connect & snapshot processing
        await new Promise((resolve) => setTimeout(resolve, 150));

        const statusBarItem = mockState.statusBarItems[0];
        expect(statusBarItem).to.not.be.undefined;
        expect(statusBarItem.visible).to.be.true;

        // 1 working, 1 idle
        expect(statusBarItem.text).to.include('1 Working');

        // Check rich markdown tooltip
        expect(statusBarItem.tooltip).to.not.be.undefined;
        const tooltipText = (statusBarItem.tooltip as any).value || '';
        expect(tooltipText).to.include('Herdr Agents (2 active)');
        expect(tooltipText).to.include('Claude-Worker');
        expect(tooltipText).to.include('Agy-Worker');

        hud.dispose();
        client.dispose();
    });

    it('displays Alert in StatusBar and triggers interactive popup on agent.blocked (H-01, H-03)', async () => {
        const client = new HerdrSocketClient(tempSockPath);
        client.on('error', () => {});
        client.connect();

        mockState.warningMessageResponse = 'Approve (y)';

        const hud = new AgentHUD(client, () => 'test-session');
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Update server mock agents to reflect blocked status on subsequent snapshot refresh
        currentMockAgents = [
            { id: 'agent-1', name: 'Claude-Worker', status: 'blocked' },
            { id: 'agent-2', name: 'Agy-Worker', status: 'idle' }
        ];

        // Push agent.blocked event from server
        for (const sock of activeSockets) {
            if (!sock.destroyed) {
                sock.write(JSON.stringify({
                    event: 'agent.blocked',
                    pane_id: 'agent-1',
                    name: 'Claude-Worker',
                    agent_status: 'blocked'
                }) + '\n');
            }
        }

        // Wait for event and refresh processing
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Status bar should highlight waiting state
        const statusBarItem = mockState.statusBarItems[0];
        expect(statusBarItem.text).to.include('Waiting');

        // Warning notification should have been shown
        expect(mockState.lastWarningMessage).to.not.be.undefined;
        expect(mockState.lastWarningMessage?.message).to.include("Agent 'Claude-Worker' requires input / confirmation");
        expect(mockState.lastWarningMessage?.items).to.include('Approve (y)');
        expect(mockState.lastWarningMessage?.items).to.include('Deny (n)');
        expect(mockState.lastWarningMessage?.items).to.include('Quick Reply...');

        // Verify that ['y', 'enter'] was sent to pane.send_keys
        const sendInputCalls = receivedCommands.filter(c => c.method === 'pane.send_keys' || c.method === 'pane.send_text' || c.method === 'pane.send_input');
        expect(sendInputCalls.length).to.be.at.least(1);
        const lastCall = sendInputCalls[sendInputCalls.length - 1];
        expect(lastCall.method).to.equal('pane.send_keys');
        expect(lastCall.params.keys).to.deep.equal(['y', 'enter']);
        expect(lastCall.params.pane_id).to.equal('agent-1');

        hud.dispose();
        client.dispose();
    });

    it('sends n and enter to agent pane when Deny (n) is selected (H-04)', async () => {
        const client = new HerdrSocketClient(tempSockPath);
        client.on('error', () => {});
        client.connect();

        mockState.warningMessageResponse = 'Deny (n)';

        const hud = new AgentHUD(client, () => 'test-session');
        await new Promise((resolve) => setTimeout(resolve, 100));

        currentMockAgents = [
            { id: 'agent-1', name: 'Claude-Worker', status: 'blocked' }
        ];

        for (const sock of activeSockets) {
            if (!sock.destroyed) {
                sock.write(JSON.stringify({
                    event: 'agent.blocked',
                    pane_id: 'agent-1',
                    name: 'Claude-Worker',
                    agent_status: 'blocked'
                }) + '\n');
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));

        const sendInputCalls = receivedCommands.filter(c => c.method === 'pane.send_keys' || c.method === 'pane.send_text' || c.method === 'pane.send_input');
        expect(sendInputCalls.length).to.be.at.least(1);
        const lastCall = sendInputCalls[sendInputCalls.length - 1];
        expect(lastCall.method).to.equal('pane.send_keys');
        expect(lastCall.params.keys).to.deep.equal(['n', 'enter']);

        hud.dispose();
        client.dispose();
    });

    it('sends text and enter to agent pane when Quick Reply is submitted', async () => {
        const client = new HerdrSocketClient(tempSockPath);
        client.on('error', () => {});
        client.connect();

        mockState.warningMessageResponse = 'Quick Reply...';
        mockState.inputBoxResponse = 'proceed with build';

        const hud = new AgentHUD(client, () => 'test-session');
        await new Promise((resolve) => setTimeout(resolve, 100));

        currentMockAgents = [
            { id: 'agent-1', name: 'Claude-Worker', status: 'blocked' }
        ];

        for (const sock of activeSockets) {
            if (!sock.destroyed) {
                sock.write(JSON.stringify({
                    event: 'agent.blocked',
                    pane_id: 'agent-1',
                    name: 'Claude-Worker',
                    agent_status: 'blocked'
                }) + '\n');
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));

        const sendInputCalls = receivedCommands.filter(c => c.method === 'pane.send_keys' || c.method === 'pane.send_text' || c.method === 'pane.send_input');
        expect(sendInputCalls.length).to.be.at.least(1);
        const lastCall = sendInputCalls[sendInputCalls.length - 1];
        expect(lastCall.method).to.equal('pane.send_input');
        expect(lastCall.params.text).to.equal('proceed with build');
        expect(lastCall.params.keys).to.deep.equal(['enter']);

        hud.dispose();
        client.dispose();
    });

    it('resets status bar when socket disconnects (H-01)', async () => {
        const client = new HerdrSocketClient(tempSockPath);
        client.on('error', () => {});
        client.connect();

        const hud = new AgentHUD(client, () => 'test-session');
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Close server-side socket to trigger client disconnect event
        for (const sock of activeSockets) {
            sock.destroy();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));

        const statusBarItem = mockState.statusBarItems[0];
        expect(statusBarItem.text).to.equal('$(hubot) Herdr');

        hud.dispose();
        client.dispose();
    });

    it('triggers attachWorkspace with unique agent ID and display name on Focus Terminal for same-named agents', async () => {
        const client = new HerdrSocketClient(tempSockPath);
        client.on('error', () => {});
        client.connect();

        mockState.warningMessageResponse = 'Focus Terminal';

        const hud = new AgentHUD(client, () => 'test-session');
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Two agents with the exact same name 'agy' in the same workspace
        currentMockAgents = [
            { id: 'pane-1', name: 'agy', status: 'blocked', workspace_id: 'ws-1' },
            { id: 'pane-2', name: 'agy', status: 'running', workspace_id: 'ws-1' }
        ];

        // Trigger blocked notification for pane-1
        for (const sock of activeSockets) {
            if (!sock.destroyed) {
                sock.write(JSON.stringify({
                    event: 'agent.blocked',
                    pane_id: 'pane-1',
                    name: 'agy',
                    agent_status: 'blocked'
                }) + '\n');
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify that attachWorkspace was invoked with pane-1 id
        const attachCalls = mockState.executedCommands.filter(c => c.command === 'herdr-collie.attachWorkspace');
        expect(attachCalls.length).to.be.at.least(1);
        const lastAttach = attachCalls[attachCalls.length - 1];
        expect(lastAttach.args[0]).to.equal('pane-1');
        expect(lastAttach.args[1]).to.be.true; // isAgent
        expect(lastAttach.args[2]).to.include('agy');
        expect(lastAttach.args[3]).to.equal('test-session');

        hud.dispose();
        client.dispose();
    });
});
