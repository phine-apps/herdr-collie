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
});
