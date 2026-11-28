/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { expect } from 'chai';
import cp = require('child_process');
import { resetMockState } from '../helpers/mockVscode';
import { HerdrWorkspaceProvider } from '../../sidebarProviders';
import { WorkspaceHUD } from '../../workspaceHUD';
import { HerdrSocketClient } from '../../socketClient';

describe('sidebarProviders Unit Tests', () => {
    beforeEach(() => {
        resetMockState();
    });

    it('fires onDidUpdateItems when socket snapshot returns empty workspaces or agents', async () => {
        const fakeSocket = {
            isConnected: true,
            getSnapshot: async () => ({
                workspaces: [],
                panes: [],
                agents: []
            })
        } as unknown as HerdrSocketClient;

        const wsProvider = new HerdrWorkspaceProvider('workspaces', fakeSocket, () => 'vscode');
        const agentProvider = new HerdrWorkspaceProvider('agents', fakeSocket, () => 'vscode');

        try {
            let wsUpdateCount = 0;
            let agentUpdateCount = 0;
            const wsSub = wsProvider.onDidUpdateItems(() => { wsUpdateCount++; });
            const agentSub = agentProvider.onDidUpdateItems(() => { agentUpdateCount++; });

            const wsItems = await wsProvider.getChildren();
            const agentItems = await agentProvider.getChildren();

            wsSub.dispose();
            agentSub.dispose();

            expect(wsUpdateCount).to.equal(1);
            expect(wsProvider.getCurrentItems()).to.deep.equal([]);
            expect(wsItems).to.have.lengthOf(1);
            expect(String(wsItems[0].label)).to.include('No workspaces found');

            expect(agentUpdateCount).to.equal(1);
            expect(agentProvider.getCurrentItems()).to.deep.equal([]);
            expect(agentItems).to.have.lengthOf(1);
            expect(String(agentItems[0].label)).to.include('No agents running');
        } finally {
            wsProvider.dispose();
            agentProvider.dispose();
        }
    });

    it('passes skipAutoStart on passive CLI fallback refreshes when socket is disconnected', async () => {
        const origExecFile = cp.execFile;
        const origSpawn = cp.spawn;
        const execCalls: string[][] = [];
        let spawnCalls = 0;

        (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            execCalls.push(args);
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            callback?.(new Error('server_not_running'), '', 'error: server_not_running');
            return {} as any;
        };
        (cp as any).spawn = () => {
            spawnCalls++;
            return { unref: () => {}, on: () => {} } as any;
        };

        const disconnectedSocket = {
            on: () => {},
            off: () => {},
            isConnected: false,
            getSnapshot: async () => null
        } as unknown as HerdrSocketClient;

        const wsProvider = new HerdrWorkspaceProvider('workspaces', disconnectedSocket, () => 'vscode');
        const agentProvider = new HerdrWorkspaceProvider('agents', disconnectedSocket, () => 'vscode');
        const wsHud = new WorkspaceHUD(disconnectedSocket, () => 'vscode', async () => []);

        try {
            await wsProvider.getChildren();
            await agentProvider.getChildren();
            await wsHud.refresh();

            expect(execCalls.some(a => a.includes('workspace') && a.includes('list'))).to.be.true;
            expect(execCalls.some(a => a.includes('agent') && a.includes('list'))).to.be.true;
            expect(spawnCalls).to.equal(0);
        } finally {
            (cp as any).execFile = origExecFile;
            (cp as any).spawn = origSpawn;
            wsProvider.dispose();
            agentProvider.dispose();
            wsHud.dispose();
        }
    });
});
