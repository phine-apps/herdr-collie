/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { HerdrSocketClient } from './socketClient';

export class HerdrWorkspaceTreeItem extends vscode.TreeItem {
    public readonly rawId: string;

    constructor(
        public readonly label: string,
        rawId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string = 'workspace',
        public readonly cwd?: string,
        public readonly branchName?: string,
        public readonly isWorktree?: boolean,
        public readonly isFocused?: boolean,
        public readonly isCurrentFolder?: boolean,
        public readonly workspaceId?: string,
        statusSignature?: string
    ) {
        super(label, collapsibleState);
        this.rawId = rawId;
        this.contextValue = contextValue;
        // Include status signature in TreeItem.id so VS Code re-renders dynamic status changes
        this.id = statusSignature ? `${rawId}:${statusSignature}` : rawId;
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
        const validSourceItems = sourceItems.filter(s => currentItems.some(i => (i.rawId || i.id) === (s.rawId || s.id)));
        if (validSourceItems.length === 0) {
            return;
        }

        const sourceIds = validSourceItems.map(s => s.rawId || (s.id ? s.id.split(':')[0] : ''));

        // If target is undefined, user dropped on empty space below the list -> move to the end
        if (!target) {
            const lastItem = currentItems[currentItems.length - 1];
            if (validSourceItems.some(s => (s.rawId || s.id) === (lastItem.rawId || lastItem.id))) {
                // Already at the end
                return;
            }
            await this.executeMove(sourceIds, null);
            return;
        }

        const targetRawId = target.rawId || (target.id ? target.id.split(':')[0] : '');

        // Cannot drop onto one of the dragged items
        if (sourceIds.includes(targetRawId)) {
            return;
        }

        const targetIndex = currentItems.findIndex(i => (i.rawId || i.id) === (target.rawId || target.id));
        if (targetIndex === -1) {
            return;
        }

        const sourceIndices = validSourceItems.map(s => currentItems.findIndex(i => (i.rawId || i.id) === (s.rawId || s.id)));
        const isDownward = Math.min(...sourceIndices) < targetIndex;

        let beforeWorkspaceId: string | null = null;

        if (isDownward) {
            // Dragged downwards: place after target, which means before the next non-source item
            let nextNonSourceItem: HerdrWorkspaceTreeItem | undefined;
            for (let i = targetIndex + 1; i < currentItems.length; i++) {
                const item = currentItems[i];
                if (!item) continue;
                const nextRawId = item.rawId || (item.id ? item.id.split(':')[0] : '');
                if (!sourceIds.includes(nextRawId)) {
                    nextNonSourceItem = item;
                    break;
                }
            }
            beforeWorkspaceId = nextNonSourceItem ? (nextNonSourceItem.rawId || (nextNonSourceItem.id ? nextNonSourceItem.id.split(':')[0] : null)) : null;
        } else {
            // Dragged upwards: place before target
            beforeWorkspaceId = targetRawId;
        }

        await this.executeMove(sourceIds, beforeWorkspaceId);
    }

    private async executeMove(workspaceIds: string[], beforeWorkspaceId: string | null): Promise<void> {
        const client = this.client;
        if (!client || !client.isConnected) {
            vscode.window.showWarningMessage(l10n.t('Herdr socket is not connected. Unable to reorder workspaces.'));
            return;
        }

        try {
            await client.moveWorkspaces(workspaceIds, beforeWorkspaceId);
            this.onDidReorder?.();
        } catch (err: any) {
            vscode.window.showErrorMessage(l10n.t('Failed to reorder workspace: {0}', err.message || String(err)));
        }
    }
}
