/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { HerdrSocketClient } from './socketClient';

export class HerdrWorkspaceTreeItem extends vscode.TreeItem {
    public readonly rawId: string;
    public tabs?: any[];

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
        statusSignature?: string,
        tabs?: any[]
    ) {
        super(label, collapsibleState);
        this.rawId = rawId;
        this.contextValue = contextValue;
        this.tabs = tabs;
        // Include status signature in TreeItem.id so VS Code re-renders dynamic status changes
        this.id = statusSignature ? `${rawId}:${statusSignature}` : rawId;
    }
}

export class HerdrTabTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly tabId: string,
        public readonly workspaceId: string,
        public readonly isFocused: boolean,
        public readonly paneCount: number = 1,
        public readonly agentStatus?: string,
        sessionName: string = 'vscode'
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'tab';
        this.id = `${workspaceId}:${tabId}`;
        this.iconPath = new vscode.ThemeIcon(isFocused ? 'window' : 'terminal');
        this.description = isFocused ? l10n.t('(Active)') : (paneCount > 1 ? `${paneCount} panes` : undefined);
        this.tooltip = l10n.t('Tab {0} (ID: {1}, Panes: {2})', label, tabId, paneCount);
        this.command = {
            command: 'herdr-collie.focusTab',
            title: l10n.t('Focus Tab'),
            arguments: [tabId, workspaceId, sessionName]
        };
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

export interface SelectionCandidate {
    id?: string;
    rawId?: string;
    cwd?: string;
    workspaceId?: string;
    isFocused?: boolean;
}

export interface AutoSelectionState {
    lastFocusedWorkspaceId?: string;
}

/**
 * Resolves whether the workspaces TreeView should automatically reveal/select the
 * Herdr-focused workspace, preserving intentional user selection of other workspaces
 * unless no valid selection exists or Herdr focus moved to a different workspace.
 */
export function resolveWorkspaceAutoSelection<T extends SelectionCandidate>(
    workspaces: T[],
    currentSelection: T | undefined,
    state: AutoSelectionState
): { target: T | undefined; focusChanged: boolean } {
    if (workspaces.length === 0) {
        state.lastFocusedWorkspaceId = undefined;
        return { target: undefined, focusChanged: false };
    }

    const focusedWs = workspaces.find(w => w.isFocused) || workspaces[0];
    const focusedId = focusedWs.rawId || focusedWs.id;
    const focusChanged = state.lastFocusedWorkspaceId !== undefined && state.lastFocusedWorkspaceId !== focusedId;
    state.lastFocusedWorkspaceId = focusedId;

    const currentId = currentSelection ? (currentSelection.rawId || currentSelection.id) : undefined;
    const currentStillExists = Boolean(currentId && workspaces.some(w => (w.rawId || w.id) === currentId));

    if ((!currentStillExists || focusChanged) && currentId !== focusedId) {
        return { target: focusedWs, focusChanged };
    }
    return { target: undefined, focusChanged };
}

/**
 * Resolves whether the agents TreeView should automatically reveal/select the
 * matching agent for the focused workspace, preserving existing valid selections
 * unless no valid selection exists or workspace focus changed.
 */
export function resolveAgentAutoSelection<T extends SelectionCandidate>(
    agents: T[],
    focusedWorkspace: SelectionCandidate | undefined,
    currentSelection: T | undefined,
    workspaceFocusChanged: boolean
): T | undefined {
    if (agents.length === 0 || !focusedWorkspace) {
        return undefined;
    }

    const focusedId = focusedWorkspace.rawId || focusedWorkspace.id;
    const matchingAgent = agents.find(a =>
        (a.workspaceId && a.workspaceId === focusedId) ||
        (a.cwd && focusedWorkspace.cwd && a.cwd === focusedWorkspace.cwd)
    );
    if (!matchingAgent) {
        return undefined;
    }

    const currentId = currentSelection ? (currentSelection.rawId || currentSelection.id) : undefined;
    const currentStillExists = Boolean(currentId && agents.some(a => (a.rawId || a.id) === currentId));
    const matchingId = matchingAgent.rawId || matchingAgent.id;

    if ((!currentStillExists || workspaceFocusChanged) && currentId !== matchingId) {
        return matchingAgent;
    }
    return undefined;
}
