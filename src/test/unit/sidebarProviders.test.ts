/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { expect } from 'chai';
import { resetMockState } from '../helpers/mockVscode';
import { HerdrWorkspaceProvider } from '../../sidebarProviders';
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
});
