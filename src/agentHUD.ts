/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { HerdrSocketClient } from './socketClient';
import { ParsedAgent, AgentStatusType, parseSnapshotAgents, parseAgents } from './parsers';
import { execHerdr } from './executors';

export class AgentHUD implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private previousAgentStates: Map<string, { status: string; statusType: AgentStatusType; name: string; isWorking: boolean; isBlocked: boolean; workspaceId?: string }> = new Map();
    private isDisposed = false;
    private notifiedBlockedAgents: Set<string> = new Set();
    private refreshSequence = 0;
    private _onDidChangeBlockedCount = new vscode.EventEmitter<number>();
    public readonly onDidChangeBlockedCount = this._onDidChangeBlockedCount.event;
    private currentBlockedCount = 0;

    constructor(
        private socketClient: HerdrSocketClient,
        private getSessionName: () => string
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'herdr-collie.statusBarHUD',
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'herdr-collie.showAgentHUD';
        this.statusBarItem.name = 'Hrdr Collie Agent HUD';
        this.updateHUDText([]);
        this.statusBarItem.show();

        this.setupSocketEvents(this.socketClient);
    }

    public updateSocketClient(newSocketClient: HerdrSocketClient): void {
        this.socketClient = newSocketClient;
        this.setupSocketEvents(this.socketClient);
        this.refresh();
    }

    private setupSocketEvents(client: HerdrSocketClient): void {
        client.on('connect', () => this.refresh());
        client.on('event', (event: any) => {
            this.handleSocketEvent(event);
            this.refresh();
        });
        client.on('disconnect', () => {
            this.updateHUDText([]);
        });
        client.on('error', () => {});
    }

    private handleSocketEvent(event: any): void {
        if (!event) return;
        // Check for direct agent notification event structures if present
        if (event.event === 'agent.blocked' || (event.agent_status && (event.agent_status === 'blocked' || event.agent_status === 'waiting'))) {
            const agentId = event.pane_id || event.id || event.agent;
            const agentName = event.name || agentId;
            if (agentId && !this.notifiedBlockedAgents.has(agentId)) {
                this.notifiedBlockedAgents.add(agentId);
                const config = vscode.workspace.getConfiguration('herdr-collie');
                if (config.get<boolean>('agentHUD.enableNotifications', true)) {
                    this.triggerBlockedNotification({
                        id: agentId,
                        name: agentName,
                        status: event.agent_status || 'blocked',
                        statusType: 'blocked',
                        statusIcon: '🔴',
                        isWorking: false,
                        isBlocked: true
                    });
                }
            }
        }
    }

    /**
     * Refreshes agents list and updates HUD & notifications
     */
    public async refresh(): Promise<void> {
        if (this.isDisposed) return;

        const seq = ++this.refreshSequence;
        let agents: ParsedAgent[] = [];

        if (this.socketClient.isConnected) {
            const snapshot = await this.socketClient.getSnapshot();
            if (this.isDisposed || seq !== this.refreshSequence) return;
            if (snapshot) {
                agents = parseSnapshotAgents(snapshot);
            }
        }

        // Fallback to CLI if empty or not connected
        if (agents.length === 0 && !this.socketClient.isConnected) {
            agents = await new Promise<ParsedAgent[]>((resolve) => {
                const session = this.getSessionName();
                execHerdr(['--session', session, 'agent', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) {
                        resolve(parseAgents(stdout));
                    } else {
                        resolve([]);
                    }
                });
            });
            if (this.isDisposed || seq !== this.refreshSequence) return;
        }

        this.processAgentStateTransitions(agents);
        this.updateHUDText(agents);
    }

    /**
     * Detects status changes and triggers interactive notifications
     */
    private processAgentStateTransitions(currentAgents: ParsedAgent[]): void {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        const enableNotifications = config.get<boolean>('agentHUD.enableNotifications', true);

        for (const agent of currentAgents) {
            const prev = this.previousAgentStates.get(agent.id);

            // Check if newly blocked
            if (agent.isBlocked) {
                if (!this.notifiedBlockedAgents.has(agent.id) && (!prev || prev.statusType !== 'blocked')) {
                    this.notifiedBlockedAgents.add(agent.id);
                    if (enableNotifications) {
                        this.triggerBlockedNotification(agent);
                    }
                }
            } else {
                // Clear notified lock if agent is no longer blocked
                this.notifiedBlockedAgents.delete(agent.id);
            }

            // Check if agent transitioned from working to done
            if (prev && prev.isWorking && agent.statusType === 'done' && enableNotifications) {
                this.triggerDoneNotification(agent);
            }

            this.previousAgentStates.set(agent.id, {
                status: agent.status,
                statusType: agent.statusType,
                name: agent.name,
                isWorking: agent.isWorking,
                isBlocked: agent.isBlocked,
                workspaceId: agent.workspaceId
            });
        }

        // Clean up removed agents
        const currentIds = new Set(currentAgents.map(a => a.id));
        for (const id of Array.from(this.previousAgentStates.keys())) {
            if (!currentIds.has(id)) {
                this.previousAgentStates.delete(id);
                this.notifiedBlockedAgents.delete(id);
            }
        }
    }

    /**
     * Displays interactive notification when agent requires user input / approval
     */
    private async triggerBlockedNotification(agent: ParsedAgent): Promise<void> {
        const sessionName = this.getSessionName();
        const approveBtn = l10n.t('Approve (y)');
        const denyBtn = l10n.t('Deny (n)');
        const replyBtn = l10n.t('Quick Reply...');
        const focusBtn = l10n.t('Focus Terminal');

        const action = await vscode.window.showWarningMessage(
            l10n.t("🤖 Agent '{0}' requires input / confirmation:", agent.name),
            approveBtn,
            denyBtn,
            replyBtn,
            focusBtn
        );

        if (action === approveBtn) {
            await this.sendKeysToAgent(agent.id, ['y', 'enter']);
            vscode.window.showInformationMessage(l10n.t("Approved tool execution for '{0}' (Sent 'y')", agent.name));
        } else if (action === denyBtn) {
            await this.sendKeysToAgent(agent.id, ['n', 'enter']);
            vscode.window.showInformationMessage(l10n.t("Denied tool execution for '{0}' (Sent 'n')", agent.name));
        } else if (action === replyBtn) {
            const reply = await vscode.window.showInputBox({
                title: l10n.t('Reply to Agent: {0}', agent.name),
                prompt: l10n.t('Enter reply to send to the agent'),
                placeHolder: l10n.t('e.g. yes, proceed with tests')
            });
            if (reply !== undefined && reply.trim().length > 0) {
                await this.sendInputToAgent(agent.id, reply.trim(), ['enter']);
                vscode.window.showInformationMessage(l10n.t("Sent reply to '{0}'", agent.name));
            }
        } else if (action === focusBtn) {
            vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName);
        }
    }

    /**
     * Helper to compute consistent display label for agent
     */
    private getAgentDisplayName(agent: ParsedAgent): string {
        const wsBadge = agent.workspaceLabel || (agent.workspaceId ? `Workspace ${agent.workspaceId}` : '');
        const agentName = agent.name && agent.name !== agent.id ? agent.name : 'Agent';
        return wsBadge ? `${agentName} [${wsBadge}]` : agentName;
    }

    /**
     * Displays completion notification
     */
    private async triggerDoneNotification(agent: ParsedAgent): Promise<void> {
        const sessionName = this.getSessionName();
        const focusBtn = l10n.t('Focus Terminal');
        const dismissBtn = l10n.t('Dismiss');

        const action = await vscode.window.showInformationMessage(
            l10n.t("✅ Agent '{0}' finished its task!", agent.name),
            focusBtn,
            dismissBtn
        );

        if (action === focusBtn) {
            vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName);
        }
    }

    /**
     * Sends key strokes (e.g. ['y', 'enter']) to agent pane
     */
    private async sendKeysToAgent(agentId: string, keys: string[]): Promise<void> {
        if (this.socketClient.isConnected) {
            try {
                await this.socketClient.sendPaneKeys(agentId, keys);
                return;
            } catch {
                // Fallback to CLI if socket fails
            }
        }

        const session = this.getSessionName();
        const sessionArgs = ['--session', session];
        execHerdr([...sessionArgs, 'pane', 'send-keys', agentId, ...keys], undefined);
    }

    /**
     * Sends text input string (and optional trailing keys like ['enter']) to agent pane
     */
    private async sendInputToAgent(agentId: string, text: string, keys?: string[]): Promise<void> {
        if (this.socketClient.isConnected) {
            try {
                await this.socketClient.sendPaneInput(agentId, text, keys);
                return;
            } catch {
                // Fallback to CLI if socket fails
            }
        }

        const session = this.getSessionName();
        const sessionArgs = ['--session', session];
        const keyArgs = keys && keys.length > 0 ? keys : [];
        execHerdr([...sessionArgs, 'pane', 'send-text', agentId, text], () => {
            if (keyArgs.length > 0) {
                execHerdr([...sessionArgs, 'pane', 'send-keys', agentId, ...keyArgs], undefined);
            }
        });
    }

    public getBlockedCount(): number {
        return this.currentBlockedCount;
    }

    /**
     * Formats status bar item text and tooltip
     */
    private updateHUDText(agents: ParsedAgent[]): void {
        const blockedCount = agents.filter(a => a.isBlocked).length;
        if (this.currentBlockedCount !== blockedCount) {
            this.currentBlockedCount = blockedCount;
            this._onDidChangeBlockedCount.fire(blockedCount);
        }

        if (agents.length === 0) {
            this.statusBarItem.text = `$(hubot) Herdr`;
            this.statusBarItem.tooltip = l10n.t('Herdr Collie: No active agents');
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        const workingCount = agents.filter(a => a.isWorking).length;
        const idleCount = agents.length - blockedCount - workingCount;

        if (blockedCount > 0) {
            this.statusBarItem.text = `$(alert) ` + l10n.t('{0} Waiting', blockedCount);
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (workingCount > 0) {
            this.statusBarItem.text = `$(sync~spin) ` + l10n.t('{0} Working', workingCount);
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(hubot) ` + l10n.t('{0} Idle', idleCount);
            this.statusBarItem.backgroundColor = undefined;
        }

        // Build rich markdown tooltip
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`### ` + l10n.t('Herdr Agents ({0} active)', agents.length) + `\n\n`);
        md.appendMarkdown(`| ${l10n.t('Agent')} | ${l10n.t('Workspace')} | ${l10n.t('Status')} | ${l10n.t('Pane ID')} |\n`);
        md.appendMarkdown(`| :--- | :--- | :--- | :--- |\n`);
        for (const a of agents) {
            const wsBadge = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '-');
            md.appendMarkdown(`| ${a.statusIcon} **${a.name}** | \`${wsBadge}\` | \`${a.status}\` | \`${a.id}\` |\n`);
        }
        md.appendMarkdown(`\n*` + l10n.t('Click to open Agent Command Palette') + `*`);
        this.statusBarItem.tooltip = md;
    }

    /**
     * Shows HUD interactive popup menu
     */
    public async showHUDQuickPick(): Promise<void> {
        const sessionName = this.getSessionName();
        let agents: ParsedAgent[] = [];

        if (this.socketClient.isConnected) {
            const snapshot = await this.socketClient.getSnapshot();
            if (snapshot) agents = parseSnapshotAgents(snapshot);
        }

        if (agents.length === 0) {
            const pick = await vscode.window.showQuickPick([
                { label: `$(rocket) ` + l10n.t('Launch Agent in Git Worktree...'), action: 'worktree' },
                { label: `$(terminal) ` + l10n.t('Launch Herdr Terminal'), action: 'terminal' },
                { label: `$(refresh) ` + l10n.t('Refresh Agents'), action: 'refresh' }
            ], {
                title: l10n.t('Herdr Collie HUD'),
                placeHolder: l10n.t('No active AI agents detected in current session')
            });

            if (pick?.action === 'worktree') {
                vscode.commands.executeCommand('herdr-collie.launchWorktreeAgent');
            } else if (pick?.action === 'terminal') {
                vscode.commands.executeCommand('herdr-collie.attachWorkspace');
            } else if (pick?.action === 'refresh') {
                this.refresh();
            }
            return;
        }

        interface AgentQuickPickItem extends vscode.QuickPickItem {
            agent: ParsedAgent;
        }

        const items: AgentQuickPickItem[] = agents.map(a => {
            const wsBadge = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
            const agentTitle = a.name && a.name !== a.id ? a.name : 'Agent';
            const label = wsBadge ? `${a.statusIcon} [${wsBadge}] ${agentTitle}` : `${a.statusIcon} ${agentTitle}`;
            return {
                label,
                description: a.isBlocked ? `⚠️ ` + l10n.t('Input Needed') + ` (${a.id})` : `(${a.id})`,
                detail: a.isBlocked 
                    ? l10n.t('⚠️ Waiting for confirmation! Click to respond or focus.') 
                    : (a.isWorking ? l10n.t('🟢 Agent is actively processing tasks...') : l10n.t('🟡 Agent is idle and ready for instructions.')),
                agent: a,
                buttons: [
                    {
                        iconPath: new vscode.ThemeIcon('terminal'),
                        tooltip: l10n.t('Attach / Focus Terminal')
                    },
                    {
                        iconPath: new vscode.ThemeIcon('comment'),
                        tooltip: l10n.t('Send Prompt to Agent')
                    },
                    ...(a.isBlocked ? [{
                        iconPath: new vscode.ThemeIcon('check'),
                        tooltip: l10n.t('Quick Approve (y)')
                    }] : [])
                ]
            };
        });

        const qp = vscode.window.createQuickPick<AgentQuickPickItem>();
        qp.title = l10n.t('Herdr Collie Agent HUD ({0})', this.getSessionName());
        qp.placeholder = l10n.t('Select an agent to interact with');
        qp.items = items;

        const quickApproveTooltip = l10n.t('Quick Approve (y)');
        const sendPromptTooltip = l10n.t('Send Prompt to Agent');

        qp.onDidTriggerItemButton(async (e) => {
            qp.hide();
            const targetAgent = e.item.agent;
            const tooltip = e.button.tooltip;

            if (tooltip === quickApproveTooltip) {
                await this.sendKeysToAgent(targetAgent.id, ['y', 'enter']);
                vscode.window.showInformationMessage(l10n.t("Sent 'y' to '{0}'", targetAgent.name));
                this.refresh();
            } else if (tooltip === sendPromptTooltip) {
                const prompt = await vscode.window.showInputBox({
                    title: l10n.t('Prompt Agent: {0}', targetAgent.name),
                    prompt: l10n.t('Enter instructions for the agent')
                });
                if (prompt && prompt.trim()) {
                    if (this.socketClient.isConnected) {
                        try {
                            await this.socketClient.sendAgentPrompt(targetAgent.id, prompt.trim());
                            vscode.window.showInformationMessage(l10n.t("Prompt sent to '{0}'", targetAgent.name));
                            this.refresh();
                            return;
                        } catch {
                            // Fallback to CLI
                        }
                    }
                    execHerdr(['--session', sessionName, 'agent', 'prompt', targetAgent.id, prompt.trim()], () => {
                        vscode.window.showInformationMessage(l10n.t("Prompt sent to '{0}'", targetAgent.name));
                        this.refresh();
                    });
                }
            } else {
                vscode.commands.executeCommand('herdr-collie.attachWorkspace', targetAgent.id, true, this.getAgentDisplayName(targetAgent), sessionName);
            }
        });

        qp.onDidAccept(async () => {
            const selected = qp.selectedItems[0];
            qp.hide();
            if (!selected) return;

            const agent = selected.agent;
            if (agent.isBlocked) {
                await this.triggerBlockedNotification(agent);
            } else {
                vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName);
            }
        });

        qp.onDidHide(() => {
            qp.dispose();
        });

        qp.show();
    }

    public dispose(): void {
        this.isDisposed = true;
        this._onDidChangeBlockedCount.dispose();
        this.statusBarItem.dispose();
    }
}
