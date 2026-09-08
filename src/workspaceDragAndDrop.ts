/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import { HerdrSocketClient } from './socketClient';

export class HerdrWorkspaceTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly id: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string = 'workspace',
        public readonly cwd?: string,
        public readonly branchName?: string,
        public readonly isWorktree?: boolean,
        public readonly isFocused?: boolean,
        public readonly isCurrentFolder?: boolean,
        public readonly workspaceId?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
    }
}

export class WorkspaceDragAndDropController implements vscode.TreeDragAndDropController<HerdrWorkspaceTreeItem> {
    public readonly dropMimeTypes = ['application/vnd.code.tree.herdr-collie.workspaces'];
    public readonly dragMimeTypes = ['application/vnd.code.tree.herdr-collie.workspaces'];

    constructor(
        private readonly getItems: () => HerdrWorkspaceTreeItem[],
        private socketClient: HerdrSocketClient | (() => HerdrSocketClient),
        private readonly onDidReorder?: () => void
    ) {}

    public updateSocketClient(newClient: HerdrSocketClient): void {
        this.socketClient = newClient;
    }

    private get client(): HerdrSocketClient {
        return typeof this.socketClient === 'function' ? this.socketClient() : this.socketClient;
    }

    public async handleDrag(
        source: readonly HerdrWorkspaceTreeItem[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        dataTransfer.set(
            'application/vnd.code.tree.herdr-collie.workspaces',
            new vscode.DataTransferItem(source)
        );
    }

    public async handleDrop(
        target: HerdrWorkspaceTreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const transferItem = dataTransfer.get('application/vnd.code.tree.herdr-collie.workspaces');
        if (!transferItem || !transferItem.value) {
            return;
        }

        const sourceItems = transferItem.value as HerdrWorkspaceTreeItem[];
        if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
            return;
        }

        const currentItems = this.getItems();
        if (!currentItems || currentItems.length === 0) {
            return;
        }

        // Filter valid source items that exist in currentItems
        const validSourceItems = sourceItems.filter(s => currentItems.some(i => i.id === s.id));
        if (validSourceItems.length === 0) {
            return;
        }

        const sourceIds = validSourceItems.map(s => s.id);

        // If target is undefined, user dropped on empty space below the list -> move to the end
        if (!target) {
            const lastItem = currentItems[currentItems.length - 1];
            if (validSourceItems.some(s => s.id === lastItem.id)) {
                // Already at the end
                return;
            }
            await this.executeMove(sourceIds, null);
            return;
        }

        // Cannot drop onto one of the dragged items
        if (sourceIds.includes(target.id)) {
            return;
        }

        const targetIndex = currentItems.findIndex(i => i.id === target.id);
        if (targetIndex === -1) {
            return;
        }

        const sourceIndices = validSourceItems.map(s => currentItems.findIndex(i => i.id === s.id));
        const isDownward = Math.min(...sourceIndices) < targetIndex;

        let beforeWorkspaceId: string | null = null;

        if (isDownward) {
            // Dragged downwards: place after target, which means before the next non-source item
            let nextNonSourceItem: HerdrWorkspaceTreeItem | undefined;
            for (let i = targetIndex + 1; i < currentItems.length; i++) {
                if (!sourceIds.includes(currentItems[i].id)) {
                    nextNonSourceItem = currentItems[i];
                    break;
                }
            }
            beforeWorkspaceId = nextNonSourceItem ? nextNonSourceItem.id : null;
        } else {
            // Dragged upwards: place before target
            beforeWorkspaceId = target.id;
        }

        await this.executeMove(sourceIds, beforeWorkspaceId);
    }

    private async executeMove(workspaceIds: string[], beforeWorkspaceId: string | null): Promise<void> {
        const client = this.client;
        if (!client || !client.isConnected) {
            vscode.window.showWarningMessage('Herdr socket is not connected. Unable to reorder workspaces.');
            return;
        }

        try {
            await client.moveWorkspaces(workspaceIds, beforeWorkspaceId);
            this.onDidReorder?.();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to reorder workspace: ${err.message || String(err)}`);
        }
    }
}
