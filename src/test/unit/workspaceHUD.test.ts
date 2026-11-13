/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode';
import { expect } from 'chai';
import { WorkspaceHUD } from '../../workspaceHUD';
import { HerdrSocketClient } from '../../socketClient';
import { mockState, resetMockState } from '../helpers/mockVscode';

describe('WorkspaceHUD Unit Tests', () => {
    let mockClient: any;

    beforeEach(() => {
        resetMockState();
        mockClient = {
            isConnected: false,
            on: () => {},
            off: () => {},
            getSnapshot: async () => null,
            dispose: () => {}
        };
    });

    it('initializes status bar item with priority 101 and selectWorkspace command', () => {
        const hud = new WorkspaceHUD(mockClient as unknown as HerdrSocketClient, () => 'default', async () => []);
        expect(mockState.statusBarItems).to.have.lengthOf(1);
        const item = mockState.statusBarItems[0];
        expect(item.id).to.equal('herdr-collie.statusBarWorkspaceHUD');
        expect(item.command).to.equal('herdr-collie.selectWorkspace');
        expect(item.text).to.equal('$(window) Herdr');
        expect(item.priority).to.equal(101);
        hud.dispose();
    });

    it('updates status bar with active workspace and branch info from socket snapshot', async () => {
        mockClient.isConnected = true;
        mockClient.getSnapshot = async () => ({
            workspaces: [
                { workspace_id: 'ws-1', label: 'feat-login', cwd: '/path/to/feat-login', focused: true }
            ],
            agents: [
                { pane_id: 'p1', name: 'claude', agent_status: 'working', workspace_id: 'ws-1' }
            ]
        });

        const mockGetWorktrees = async () => [
            { worktree: '/path/to/feat-login', head: 'abc1234', branch: 'feat/login' }
        ];

        const hud = new WorkspaceHUD(
            mockClient as unknown as HerdrSocketClient,
            () => 'default',
            mockGetWorktrees,
            () => '/path/to/other'
        );

        await hud.refresh();

        const item = mockState.statusBarItems[0];
        expect(item.text).to.equal('$(git-branch) feat/login');
        expect(item.tooltip.value).to.include('Herdr Workspace: feat-login');
        expect(item.tooltip.value).to.include('**Branch**: `feat/login` (Git Worktree)');
        expect(item.tooltip.value).to.include('**Active Agents**: claude 🟢');

        hud.dispose();
    });

    it('shows folder-active icon when workspace matches current VS Code project', async () => {
        mockClient.isConnected = true;
        mockClient.getSnapshot = async () => ({
            workspaces: [
                { workspace_id: 'ws-local', label: 'collie-core', cwd: '/path/to/my-project', focused: true }
            ],
            agents: []
        });

        const hud = new WorkspaceHUD(
            mockClient as unknown as HerdrSocketClient,
            () => 'default',
            async () => [],
            () => '/path/to/my-project'
        );

        await hud.refresh();

        const item = mockState.statusBarItems[0];
        expect(item.text).to.equal('$(folder-active) collie-core');
        expect(item.tooltip.value).to.include('**VS Code Window**: Matches active project');

        hud.dispose();
    });

    it('cleans up socket event listeners on updateSocketClient and dispose', () => {
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
            on: (event: string, fn: Function) => {},
            off: () => {},
            getSnapshot: async () => null,
            isConnected: false
        };

        const hud = new WorkspaceHUD(client1 as unknown as HerdrSocketClient, () => 'default', async () => []);
        expect(registeredListeners['connect']).to.have.lengthOf(1);
        expect(registeredListeners['event']).to.have.lengthOf(1);
        expect(registeredListeners['disconnect']).to.have.lengthOf(1);

        // Update socket client
        hud.updateSocketClient(client2 as unknown as HerdrSocketClient);
        expect(removedListeners['connect']).to.have.lengthOf(1);
        expect(removedListeners['event']).to.have.lengthOf(1);
        expect(removedListeners['disconnect']).to.have.lengthOf(1);

        // Dispose
        hud.dispose();
    });

    it('coalesces bursty socket event refreshes in WorkspaceHUD', async () => {
        const { EventEmitter } = require('events');
        const emitterClient: any = new EventEmitter();
        emitterClient.isConnected = true;
        let snapshotCalls = 0;
        emitterClient.getSnapshot = async () => {
            snapshotCalls++;
            return {
                workspaces: [{ workspace_id: 'ws-1', label: 'Primary', cwd: '/repo', focused: true }],
                agents: []
            };
        };

        const hud = new WorkspaceHUD(emitterClient as unknown as HerdrSocketClient, () => 'default', async () => []);
        emitterClient.emit('event', { type: 'workspace.updated' });
        emitterClient.emit('event', { type: 'pane.output' });
        emitterClient.emit('event', { type: 'layout.updated' });

        await new Promise(r => setTimeout(r, 70));
        expect(snapshotCalls).to.equal(1);

        hud.dispose();
    });

    it('coalesces concurrent HerdrSocketClient.getSnapshot calls and invalidates cache on event', async () => {
        const client = new HerdrSocketClient('test-coalesce');
        let requestCalls = 0;
        (client as any).request = async () => {
            requestCalls++;
            await new Promise(r => setTimeout(r, 15));
            return {
                snapshot: {
                    workspaces: [{ workspace_id: `ws-${requestCalls}`, label: 'Primary', focused: true }],
                    agents: []
                }
            };
        };

        // Concurrent calls share a single in-flight request
        const [s1, s2, s3] = await Promise.all([
            client.getSnapshot(150),
            client.getSnapshot(150),
            client.getSnapshot()
        ]);
        expect(requestCalls).to.equal(1);
        expect(s1).to.equal(s2);
        expect(s1).to.equal(s3);

        // Sequential call within maxAgeMs uses short-lived cache
        const sCached = await client.getSnapshot(150);
        expect(requestCalls).to.equal(1);
        expect(sCached).to.equal(s1);

        // New event invalidates cache immediately so next getSnapshot fetches fresh state
        (client as any).handleMessage({ type: 'workspace.focused' });
        const sFresh = await client.getSnapshot(150);
        expect(requestCalls).to.equal(2);
        expect(sFresh?.workspaces?.[0].workspace_id).to.equal('ws-2');

        client.dispose();
    });
});
