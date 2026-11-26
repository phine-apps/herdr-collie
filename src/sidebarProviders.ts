/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as os from 'os';
import * as path from 'path';
import { execHerdr } from './executors';
import {
    formatAgentDisplay,
    formatWorkspaceDisplay,
    sortAgents,
    AgentSortOrder
} from './formatters';
import {
    parseWorkspaces,
    parseAgents,
    parsePanes,
    parseSnapshotWorkspaces,
    parseSnapshotAgents,
    parseSnapshotTabs,
    parseTabs,
    ParsedAgent
} from './parsers';
import { HerdrSocketClient } from './socketClient';
import { HerdrWorkspaceTreeItem, HerdrTabTreeItem } from './workspaceDragAndDrop';
import { isWorkspaceTrusted } from './workspaceTrust';
import { getWorktreesForCwds } from './gitContext';

export class HerdrSessionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly sessionName: string,
        public readonly isActive: boolean
    ) {
        super(sessionName, vscode.TreeItemCollapsibleState.None);
        this.contextValue = sessionName === 'default' ? 'defaultSession' : 'deletableSession';
        this.description = isActive ? l10n.t('(active)') : '';
        this.iconPath = new vscode.ThemeIcon(isActive ? 'star-full' : 'symbol-event');
        this.tooltip = isActive ? l10n.t('Active Herdr Session: {0}', sessionName) : l10n.t('Click to switch to session: {0}', sessionName);
        if (!isActive) {
            this.command = {
                command: 'herdr-collie.switchSessionDirect',
                title: l10n.t('Switch Session'),
                arguments: [sessionName]
            };
        }
    }
}

export class HerdrSessionProvider implements vscode.TreeDataProvider<HerdrSessionTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<HerdrSessionTreeItem | undefined | null | void> = new vscode.EventEmitter<HerdrSessionTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<HerdrSessionTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(
        private readonly getActiveSession: () => string,
        private readonly getSessions: () => Promise<string[]>
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose() {
        this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: HerdrSessionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<HerdrSessionTreeItem[]> {
        const activeSession = this.getActiveSession();
        const sessions = await this.getSessions();

        const allSessions = Array.from(new Set([activeSession, ...sessions]));
        allSessions.sort((a, b) => {
            if (a === activeSession) return -1;
            if (b === activeSession) return 1;
            if (a === 'default') return -1;
            if (b === 'default') return 1;
            return a.localeCompare(b);
        });

        return allSessions.map(s => new HerdrSessionTreeItem(s, s === activeSession));
    }
}

export class HerdrWorkspaceProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private _onDidUpdateItems: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidUpdateItems: vscode.Event<void> = this._onDidUpdateItems.event;
    private sortOrder: AgentSortOrder = 'grouped';
    private currentItems: HerdrWorkspaceTreeItem[] = [];
    private nextSnapshotMaxAgeMs = 0;

    constructor(
        private readonly type: 'workspaces' | 'agents',
        private socketClient: HerdrSocketClient,
        private readonly getSessionName: () => string,
        private readonly extensionUri?: vscode.Uri,
        private readonly enrichAgents?: (agents: ParsedAgent[]) => ParsedAgent[]
    ) {}

    private getIconPath(iconFile: string): vscode.Uri {
        if (this.extensionUri) {
            return vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', iconFile);
        }
        return vscode.Uri.file(path.join(__dirname, '..', 'media', 'icons', iconFile));
    }

    getParent(_element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
        return null;
    }

    getCurrentItems(): HerdrWorkspaceTreeItem[] {
        return this.currentItems;
    }

    setSortOrder(newOrder: AgentSortOrder) {
        this.sortOrder = newOrder;
        this.refresh();
    }

    getSortOrder(): AgentSortOrder {
        return this.sortOrder;
    }

    toggleSortOrder(): AgentSortOrder {
        this.sortOrder = this.sortOrder === 'grouped' ? 'priority' : 'grouped';
        this.refresh();
        return this.sortOrder;
    }

    updateSocketClient(newSocketClient: HerdrSocketClient) {
        this.socketClient = newSocketClient;
        this.refresh();
    }

    refresh(options?: { maxAgeMs?: number }): void {
        this.nextSnapshotMaxAgeMs = options?.maxAgeMs ?? 0;
        this._onDidChangeTreeData.fire();
    }

    dispose() {
        this._onDidChangeTreeData.dispose();
        this._onDidUpdateItems.dispose();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element) {
            if (this.type === 'workspaces' && element instanceof HerdrWorkspaceTreeItem && element.tabs && element.tabs.length > 0) {
                const sessionName = this.getSessionName();
                return element.tabs.map(tab => new HerdrTabTreeItem(
                    tab.label ? `Tab ${tab.label}` : `Tab ${tab.number || tab.id}`,
                    tab.id,
                    element.rawId,
                    tab.focused,
                    tab.paneCount,
                    tab.agentStatus,
                    sessionName
                ));
            }
            return [];
        }

        const sessionName = this.getSessionName();
        const maxAgeMs = this.nextSnapshotMaxAgeMs;
        this.nextSnapshotMaxAgeMs = 0;

        // 1. Try fetching via fast Unix Domain Socket snapshot (Zero process execution)
        try {
            if (this.socketClient.isConnected) {
                const snapshot = await this.socketClient.getSnapshot(maxAgeMs);
                if (snapshot) {
                    if (this.type === 'workspaces') {
                        const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                        const parsedAgents = parseSnapshotAgents(snapshot, parsedWorkspaces);
                        const parsedTabs = parseSnapshotTabs(snapshot);
                        const worktrees = await getWorktreesForCwds(parsedWorkspaces.map(w => w.cwd));
                        const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

                        if (parsedWorkspaces.length > 0) {
                            const items = parsedWorkspaces.map(ws => {
                                const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAgents, currentRoot);
                                const contextValue = displayInfo.isWorktree ? 'worktreeWorkspace' : 'workspace';
                                const wsTabs = parsedTabs.filter(t => t.workspaceId === ws.id);
                                const collapsibleState = wsTabs.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;

                                const item = new HerdrWorkspaceTreeItem(
                                    displayInfo.label,
                                    ws.id,
                                    collapsibleState,
                                    contextValue,
                                    ws.cwd,
                                    displayInfo.branchName,
                                    displayInfo.isWorktree,
                                    displayInfo.isFocused,
                                    displayInfo.isCurrentWindow,
                                    undefined,
                                    undefined,
                                    wsTabs
                                );

                                item.description = displayInfo.description;
                                item.tooltip = displayInfo.tooltip;
                                item.iconPath = this.getIconPath(displayInfo.statusIconFile);
                                item.command = {
                                    command: 'herdr-collie.attachWorkspace',
                                    title: l10n.t('Attach'),
                                    arguments: [ws.id, false, ws.label, sessionName]
                                };
                                return item;
                            });
                            this.currentItems = items;
                            this._onDidUpdateItems.fire();
                            return items;
                        }
                        this.currentItems = [];
                        this._onDidUpdateItems.fire();
                        const emptyItem = new vscode.TreeItem(l10n.t('(No workspaces found)'), vscode.TreeItemCollapsibleState.None);
                        emptyItem.iconPath = new vscode.ThemeIcon('info');
                        return [emptyItem];
                    }

                    if (this.type === 'agents') {
                        const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                        const rawParsedAgents = parseSnapshotAgents(snapshot, parsedWorkspaces);
                        const parsedAgents = this.enrichAgents ? this.enrichAgents(rawParsedAgents) : rawParsedAgents;
                        const sortedAgents = sortAgents(parsedAgents, this.sortOrder);
                        const worktrees = await getWorktreesForCwds(sortedAgents.map(a => a.workspaceCwd));

                        if (sortedAgents.length > 0) {
                            const items = sortedAgents.map(a => {
                                const displayInfo = formatAgentDisplay(a, worktrees);

                                const item = new HerdrWorkspaceTreeItem(
                                    displayInfo.agentName,
                                    a.id,
                                    vscode.TreeItemCollapsibleState.None,
                                    a.isBlocked ? 'blockedAgent' : 'agent',
                                    a.workspaceCwd,
                                    displayInfo.branchName,
                                    false,
                                    false,
                                    false,
                                    a.workspaceId,
                                    undefined
                                );
                                item.description = displayInfo.description;
                                item.tooltip = displayInfo.tooltip;
                                item.iconPath = this.getIconPath(displayInfo.statusIconFile);
                                item.command = {
                                    command: 'herdr-collie.attachWorkspace',
                                    title: l10n.t('Attach'),
                                    arguments: [a.id, true, displayInfo.displayLabel, sessionName, a.workspaceId]
                                };
                                return item;
                            });
                            this.currentItems = items;
                            this._onDidUpdateItems.fire();
                            return items;
                        }
                        this.currentItems = [];
                        this._onDidUpdateItems.fire();
                        const emptyItem = new vscode.TreeItem(l10n.t('(No agents running)'), vscode.TreeItemCollapsibleState.None);
                        emptyItem.iconPath = new vscode.ThemeIcon('info');
                        return [emptyItem];
                    }
                }
            }
        } catch (err) {
            console.error(`[herdr-collie] Error loading ${this.type} from socket snapshot:`, err);
        }

        // 2. CLI Fallback if socket is not connected
        if (!isWorkspaceTrusted(vscode)) {
            this.currentItems = [];
            const restrictedItem = new vscode.TreeItem(
                l10n.t('(Restricted Mode — trust workspace to connect Herdr)'),
                vscode.TreeItemCollapsibleState.None
            );
            restrictedItem.iconPath = new vscode.ThemeIcon('shield');
            return [restrictedItem];
        }
        return new Promise((resolve) => {
            const sessionArgs = ['--session', sessionName];

            if (this.type === 'workspaces') {
                let rawWorkspaces = '';
                let rawPanes = '';
                let rawAgents = '';
                let rawTabs = '';
                let pending = 4;

                const checkDone = async () => {
                    pending--;
                    if (pending === 0) {
                        const parsedPanes = parsePanes(rawPanes);
                        const parsedWorkspaces = parseWorkspaces(rawWorkspaces, parsedPanes, os.homedir());
                        const parsedAgents = parseAgents(rawAgents, parsedWorkspaces);
                        const parsedTabs = parseTabs(rawTabs);
                        const worktrees = await getWorktreesForCwds(parsedWorkspaces.map(w => w.cwd));
                        const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        const items: vscode.TreeItem[] = [];

                        parsedWorkspaces.forEach(ws => {
                            const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAgents, currentRoot);
                            const contextValue = displayInfo.isWorktree ? 'worktreeWorkspace' : 'workspace';
                            const wsTabs = parsedTabs.filter(t => t.workspaceId === ws.id);
                            const collapsibleState = wsTabs.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;

                            const item = new HerdrWorkspaceTreeItem(
                                displayInfo.label,
                                ws.id,
                                collapsibleState,
                                contextValue,
                                ws.cwd,
                                displayInfo.branchName,
                                displayInfo.isWorktree,
                                displayInfo.isFocused,
                                displayInfo.isCurrentWindow,
                                undefined,
                                undefined,
                                wsTabs
                            );
                            item.description = displayInfo.description;
                            item.tooltip = displayInfo.tooltip;
                            item.iconPath = this.getIconPath(displayInfo.statusIconFile);
                            item.command = {
                                command: 'herdr-collie.attachWorkspace',
                                title: l10n.t('Attach'),
                                arguments: [ws.id, false, ws.label, sessionName]
                            };
                            items.push(item);
                        });

                        this.currentItems = items.filter(i => i instanceof HerdrWorkspaceTreeItem) as HerdrWorkspaceTreeItem[];
                        this._onDidUpdateItems.fire();
                        if (items.length === 0) {
                            const emptyItem = new vscode.TreeItem(l10n.t('(No workspaces found)'), vscode.TreeItemCollapsibleState.None);
                            emptyItem.iconPath = new vscode.ThemeIcon('info');
                            items.push(emptyItem);
                        }
                        resolve(items);
                    }
                };

                execHerdr([...sessionArgs, 'workspace', 'list'], (err, stdout) => {
                    if (!err && stdout) {
                        rawWorkspaces = stdout;
                    }
                    checkDone();
                });

                execHerdr([...sessionArgs, 'pane', 'list'], (err, stdout) => {
                    if (!err && stdout) {
                        rawPanes = stdout;
                    }
                    checkDone();
                });

                execHerdr([...sessionArgs, 'agent', 'list'], (err, stdout) => {
                    if (!err && stdout) {
                        rawAgents = stdout;
                    }
                    checkDone();
                });

                execHerdr([...sessionArgs, 'tab', 'list'], (err, stdout) => {
                    if (!err && stdout) {
                        rawTabs = stdout;
                    }
                    checkDone();
                });
                return;
            }

            if (this.type === 'agents') {
                let rawWorkspaces = '';
                let rawPanes = '';
                let rawAgents = '';
                let pending = 3;

                const checkDone = async () => {
                    pending--;
                    if (pending === 0) {
                        const parsedPanes = parsePanes(rawPanes);
                        const parsedWorkspaces = parseWorkspaces(rawWorkspaces, parsedPanes, os.homedir());
                        const rawParsedAgents = parseAgents(rawAgents, parsedWorkspaces);
                        const parsedAgents = this.enrichAgents ? this.enrichAgents(rawParsedAgents) : rawParsedAgents;
                        const sortedAgents = sortAgents(parsedAgents, this.sortOrder);
                        const worktrees = await getWorktreesForCwds(sortedAgents.map(a => a.workspaceCwd));

                        const items: vscode.TreeItem[] = [];
                        sortedAgents.forEach(a => {
                            const displayInfo = formatAgentDisplay(a, worktrees);

                            const item = new HerdrWorkspaceTreeItem(
                                displayInfo.agentName,
                                a.id,
                                vscode.TreeItemCollapsibleState.None,
                                a.isBlocked ? 'blockedAgent' : 'agent',
                                a.workspaceCwd,
                                displayInfo.branchName,
                                false,
                                false,
                                false,
                                a.workspaceId,
                                undefined
                            );
                            item.description = displayInfo.description;
                            item.tooltip = displayInfo.tooltip;
                            item.iconPath = this.getIconPath(displayInfo.statusIconFile);
                            item.command = {
                                command: 'herdr-collie.attachWorkspace',
                                title: l10n.t('Attach'),
                                arguments: [a.id, true, displayInfo.displayLabel, sessionName, a.workspaceId]
                            };
                            items.push(item);
                        });

                        this.currentItems = items.filter(i => i instanceof HerdrWorkspaceTreeItem) as HerdrWorkspaceTreeItem[];
                        this._onDidUpdateItems.fire();
                        if (items.length === 0) {
                            const emptyItem = new vscode.TreeItem(l10n.t('(No agents running)'), vscode.TreeItemCollapsibleState.None);
                            emptyItem.iconPath = new vscode.ThemeIcon('info');
                            items.push(emptyItem);
                        }
                        resolve(items);
                    }
                };

                execHerdr([...sessionArgs, 'workspace', 'list'], (err, stdout) => {
                    if (!err && stdout) rawWorkspaces = stdout;
                    checkDone();
                });

                execHerdr([...sessionArgs, 'pane', 'list'], (err, stdout) => {
                    if (!err && stdout) rawPanes = stdout;
                    checkDone();
                });

                execHerdr([...sessionArgs, 'agent', 'list'], (err, stdout) => {
                    if (!err && stdout) rawAgents = stdout;
                    checkDone();
                });
                return;
            }
        });
    }
}
