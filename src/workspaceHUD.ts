/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { HerdrSocketClient } from './socketClient';
import { 
    ParsedWorkspace, 
    ParsedAgent, 
    parseSnapshotWorkspaces, 
    parseSnapshotAgents, 
    parseWorkspaces, 
    parsePanes,
    GitWorktreeInfo 
} from './parsers';
import { execHerdr } from './executors';
import { formatWorkspaceDisplay, WorkspaceDisplayInfo } from './formatters';

export class WorkspaceHUD implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private isDisposed = false;
    private refreshSequence = 0;
    private connectListener?: () => void;
    private eventListener?: () => void;
    private disconnectListener?: () => void;

    constructor(
        private socketClient: HerdrSocketClient,
        private getSessionName: () => string,
        private getWorktrees: (cwds: (string | undefined)[]) => Promise<GitWorktreeInfo[]>,
        private getCurrentWorkspaceFolder: () => string | undefined = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'herdr-collie.statusBarWorkspaceHUD',
            vscode.StatusBarAlignment.Right,
            101 // Positioned immediately to the left of Agent HUD (priority 100)
        );
        this.statusBarItem.command = 'herdr-collie.selectWorkspace';
        this.statusBarItem.name = 'Herdr Collie Workspace HUD';
        this.updateHUDText(undefined);
        this.statusBarItem.show();

        this.setupSocketEvents(this.socketClient);
    }

    public updateSocketClient(newSocketClient: HerdrSocketClient): void {
        this.cleanupSocketEvents();
        this.socketClient = newSocketClient;
        this.setupSocketEvents(this.socketClient);
        this.refresh();
    }

    private setupSocketEvents(client: HerdrSocketClient): void {
        this.connectListener = () => this.refresh();
        this.eventListener = () => this.refresh();
        this.disconnectListener = () => {
            this.updateHUDText(undefined);
        };

        client.on('connect', this.connectListener);
        client.on('event', this.eventListener);
        client.on('disconnect', this.disconnectListener);
        client.on('error', () => {});
    }

    private cleanupSocketEvents(): void {
        if (this.socketClient && typeof (this.socketClient as any).off === 'function') {
            if (this.connectListener) {
                this.socketClient.off('connect', this.connectListener);
                this.connectListener = undefined;
            }
            if (this.eventListener) {
                this.socketClient.off('event', this.eventListener);
                this.eventListener = undefined;
            }
            if (this.disconnectListener) {
                this.socketClient.off('disconnect', this.disconnectListener);
                this.disconnectListener = undefined;
            }
        }
    }

    /**
     * Refreshes active workspace and updates status bar display
     */
    public async refresh(): Promise<void> {
        if (this.isDisposed) return;

        const seq = ++this.refreshSequence;
        let workspaces: ParsedWorkspace[] = [];
        let agents: ParsedAgent[] = [];

        if (this.socketClient.isConnected) {
            const snapshot = await this.socketClient.getSnapshot();
            if (this.isDisposed || seq !== this.refreshSequence) return;
            if (snapshot) {
                workspaces = parseSnapshotWorkspaces(snapshot);
                agents = parseSnapshotAgents(snapshot, workspaces);
            }
        }

        // Fallback to CLI if empty or socket not connected
        if (workspaces.length === 0 && !this.socketClient.isConnected) {
            workspaces = await new Promise<ParsedWorkspace[]>((resolve) => {
                const session = this.getSessionName();
                const sessionArgs = ['--session', session];
                let rawWorkspaces = '';
                let rawPanes = '';
                let pending = 2;

                const checkDone = () => {
                    pending--;
                    if (pending === 0) {
                        const parsedPanes = parsePanes(rawPanes);
                        resolve(parseWorkspaces(rawWorkspaces, parsedPanes));
                    }
                };

                execHerdr([...sessionArgs, 'workspace', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) rawWorkspaces = stdout;
                    checkDone();
                });

                execHerdr([...sessionArgs, 'pane', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) rawPanes = stdout;
                    checkDone();
                });
            });
            if (this.isDisposed || seq !== this.refreshSequence) return;
        }

        const focusedWs = workspaces.find(w => w.focused) || workspaces[0];
        if (!focusedWs) {
            this.updateHUDText(undefined);
            return;
        }

        const worktrees = await this.getWorktrees([focusedWs.cwd]);
        if (this.isDisposed || seq !== this.refreshSequence) return;

        const currentFolder = this.getCurrentWorkspaceFolder();
        const displayInfo = formatWorkspaceDisplay(focusedWs, worktrees, agents, currentFolder);
        this.updateHUDText(displayInfo);
    }

    /**
     * Formats status bar item text and markdown tooltip
     */
    private updateHUDText(displayInfo?: WorkspaceDisplayInfo): void {
        if (!displayInfo) {
            this.statusBarItem.text = `$(window) Herdr`;
            this.statusBarItem.tooltip = l10n.t('Herdr Collie: No workspace active\nClick to select workspace');
            return;
        }

        const icon = displayInfo.isWorktree ? '$(git-branch)' : (displayInfo.isCurrentWindow ? '$(folder-active)' : '$(window)');
        const label = displayInfo.branchName || displayInfo.label;
        this.statusBarItem.text = `${icon} ${label}`;

        // Build rich markdown tooltip
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`### ` + l10n.t('Herdr Workspace: {0} Active', `${displayInfo.label} $(check)`) + `\n\n`);
        if (displayInfo.branchName) {
            md.appendMarkdown(`* ` + l10n.t('**Branch**: `{0}` (Git Worktree)', displayInfo.branchName) + `\n`);
        }
        if (displayInfo.isCurrentWindow) {
            md.appendMarkdown(`* ` + l10n.t('**VS Code Window**: Matches active project') + `\n`);
        }
        if (displayInfo.agentBadges) {
            md.appendMarkdown(`* ` + l10n.t('**Active Agents**: {0}', displayInfo.agentBadges) + `\n`);
        }
        md.appendMarkdown(`\n*` + l10n.t('Click to switch or focus workspace (Ctrl+Alt+H W)') + `*`);
        this.statusBarItem.tooltip = md;
    }

    public dispose(): void {
        this.isDisposed = true;
        this.cleanupSocketEvents();
        this.statusBarItem.dispose();
    }
}
