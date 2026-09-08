/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import { mockState, resetMockState, mockVscode } from '../helpers/mockVscode';
import { HerdrWorkspaceTreeItem, WorkspaceDragAndDropController } from '../../workspaceDragAndDrop';
import { HerdrSocketClient } from '../../socketClient';

describe('WorkspaceDragAndDropController Unit Tests', () => {
    let mockItems: HerdrWorkspaceTreeItem[];
    let lastMoveCall: { workspaceIds: string[]; beforeWorkspaceId: string | null } | null = null;
    let isConnected = true;
    let reorderCallbackCalled = false;

    // Create a mock socket client
    const createMockSocketClient = () => {
        return {
            get isConnected() {
                return isConnected;
            },
            async moveWorkspaces(workspaceIds: string[], beforeWorkspaceId: string | null) {
                lastMoveCall = { workspaceIds, beforeWorkspaceId };
                return { success: true };
            }
        } as unknown as HerdrSocketClient;
    };

    beforeEach(() => {
        resetMockState();
        lastMoveCall = null;
        isConnected = true;
        reorderCallbackCalled = false;

        mockItems = [
            new HerdrWorkspaceTreeItem('WS 1', 'ws-1', mockVscode.TreeItemCollapsibleState.None),
            new HerdrWorkspaceTreeItem('WS 2', 'ws-2', mockVscode.TreeItemCollapsibleState.None),
            new HerdrWorkspaceTreeItem('WS 3', 'ws-3', mockVscode.TreeItemCollapsibleState.None)
        ];
    });

    it('sets dragMimeTypes and dropMimeTypes correctly', () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        expect(controller.dragMimeTypes).to.include('application/vnd.code.tree.herdr-collie.workspaces');
        expect(controller.dropMimeTypes).to.include('application/vnd.code.tree.herdr-collie.workspaces');
    });

    it('handleDrag sets source items into data transfer with correct mime type', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        const sources = [mockItems[0]];

        await controller.handleDrag(sources, dataTransfer as any, {} as any);

        const item = dataTransfer.get('application/vnd.code.tree.herdr-collie.workspaces');
        expect(item).to.exist;
        expect(item.value).to.deep.equal(sources);
    });

    it('handleDrop returns early when transfer item is missing', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        await controller.handleDrop(mockItems[1], dataTransfer as any, {} as any);

        expect(lastMoveCall).to.be.null;
        expect(reorderCallbackCalled).to.be.false;
    });

    it('handleDrop returns early when dropping onto oneself', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[0]]));

        await controller.handleDrop(mockItems[0], dataTransfer as any, {} as any);

        expect(lastMoveCall).to.be.null;
        expect(reorderCallbackCalled).to.be.false;
    });

    it('handleDrop reorders upwards: moving item 2 onto item 0 inserts before item 0', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[2]]));

        // Drag WS 3 (index 2) onto WS 1 (index 0)
        await controller.handleDrop(mockItems[0], dataTransfer as any, {} as any);

        expect(lastMoveCall).to.deep.equal({
            workspaceIds: ['ws-3'],
            beforeWorkspaceId: 'ws-1'
        });
        expect(reorderCallbackCalled).to.be.true;
    });

    it('handleDrop reorders downwards: moving item 0 onto item 1 inserts before item 2 (after item 1)', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[0]]));

        // Drag WS 1 (index 0) onto WS 2 (index 1)
        await controller.handleDrop(mockItems[1], dataTransfer as any, {} as any);

        expect(lastMoveCall).to.deep.equal({
            workspaceIds: ['ws-1'],
            beforeWorkspaceId: 'ws-3'
        });
        expect(reorderCallbackCalled).to.be.true;
    });

    it('handleDrop reorders downwards to the end: moving item 0 onto last item inserts before null', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[0]]));

        // Drag WS 1 (index 0) onto WS 3 (index 2, last item)
        await controller.handleDrop(mockItems[2], dataTransfer as any, {} as any);

        expect(lastMoveCall).to.deep.equal({
            workspaceIds: ['ws-1'],
            beforeWorkspaceId: null
        });
        expect(reorderCallbackCalled).to.be.true;
    });

    it('handleDrop on empty space (target undefined) moves item to the end', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[0]]));

        // Drop on undefined target (empty space at bottom)
        await controller.handleDrop(undefined, dataTransfer as any, {} as any);

        expect(lastMoveCall).to.deep.equal({
            workspaceIds: ['ws-1'],
            beforeWorkspaceId: null
        });
        expect(reorderCallbackCalled).to.be.true;
    });

    it('handleDrop on empty space does nothing if item is already at the end', async () => {
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[2]]));

        // Drop last item on undefined target
        await controller.handleDrop(undefined, dataTransfer as any, {} as any);

        expect(lastMoveCall).to.be.null;
        expect(reorderCallbackCalled).to.be.false;
    });

    it('handleDrop warns user when socket is not connected', async () => {
        isConnected = false;
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            createMockSocketClient(),
            () => { reorderCallbackCalled = true; }
        );

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[0]]));

        await controller.handleDrop(mockItems[1], dataTransfer as any, {} as any);

        expect(lastMoveCall).to.be.null;
        expect(mockState.lastWarningMessage?.message).to.include('Herdr socket is not connected');
    });

    it('updateSocketClient updates the active socket client instance', async () => {
        const initialClient = createMockSocketClient();
        const controller = new WorkspaceDragAndDropController(
            () => mockItems,
            initialClient
        );

        let newClientCall = false;
        const newClient = {
            isConnected: true,
            async moveWorkspaces() {
                newClientCall = true;
                return { success: true };
            }
        } as unknown as HerdrSocketClient;

        controller.updateSocketClient(newClient);

        const dataTransfer = new mockVscode.DataTransfer();
        dataTransfer.set('application/vnd.code.tree.herdr-collie.workspaces', new mockVscode.DataTransferItem([mockItems[0]]));

        await controller.handleDrop(mockItems[1], dataTransfer as any, {} as any);
        expect(newClientCall).to.be.true;
    });
});
