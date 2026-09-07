/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import { HerdrSocketClient } from './socketClient';
import { ParsedAgent, AgentStatusType, parseSnapshotAgents, parseAgents } from './parsers';
import { execHerdr } from './executors';

export class AgentHUD implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private previousAgentStates: Map<string, { status: string; statusType: AgentStatusType; name: string; isWorking: boolean; isBlocked: boolean; workspaceId?: string }> = new Map();
    private isDisposed = false;
    private notifiedBlockedAgents: Set<string> = new Set();
    private refreshSequence = 0;

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
        const action = await vscode.window.showWarningMessage(
            `🤖 Agent '${agent.name}' requires input / confirmation:`,
            'Approve (y)',
            'Deny (n)',
            'Quick Reply...',
            'Focus Terminal'
        );

        if (action === 'Approve (y)') {
            await this.sendKeysToAgent(agent.id, ['y', 'enter']);
            vscode.window.showInformationMessage(`Approved tool execution for '${agent.name}' (Sent 'y')`);
        } else if (action === 'Deny (n)') {
            await this.sendKeysToAgent(agent.id, ['n', 'enter']);
            vscode.window.showInformationMessage(`Denied tool execution for '${agent.name}' (Sent 'n')`);
        } else if (action === 'Quick Reply...') {
            const reply = await vscode.window.showInputBox({
                title: `Reply to Agent: ${agent.name}`,
                prompt: 'Enter reply to send to the agent',
                placeHolder: 'e.g. yes, proceed with tests'
            });
            if (reply !== undefined && reply.trim().length > 0) {
                await this.sendInputToAgent(agent.id, reply.trim(), ['enter']);
                vscode.window.showInformationMessage(`Sent reply to '${agent.name}'`);
            }
        } else if (action === 'Focus Terminal') {
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
        const action = await vscode.window.showInformationMessage(
            `✅ Agent '${agent.name}' finished its task!`,
            'Focus Terminal',
            'Dismiss'
        );

        if (action === 'Focus Terminal') {
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

    /**
     * Formats status bar item text and tooltip
     */
    private updateHUDText(agents: ParsedAgent[]): void {
        if (agents.length === 0) {
            this.statusBarItem.text = `$(hubot) Herdr`;
            this.statusBarItem.tooltip = 'Herdr Collie: No active agents';
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        const blockedCount = agents.filter(a => a.isBlocked).length;
        const workingCount = agents.filter(a => a.isWorking).length;
        const idleCount = agents.length - blockedCount - workingCount;

        if (blockedCount > 0) {
            this.statusBarItem.text = `$(alert) ${blockedCount} Waiting`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (workingCount > 0) {
            this.statusBarItem.text = `$(sync~spin) ${workingCount} Working`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(hubot) ${idleCount} Idle`;
            this.statusBarItem.backgroundColor = undefined;
        }

        // Build rich markdown tooltip
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`### Herdr Agents (${agents.length} active)\n\n`);
        md.appendMarkdown(`| Agent | Workspace | Status | Pane ID |\n`);
        md.appendMarkdown(`| :--- | :--- | :--- | :--- |\n`);
        for (const a of agents) {
            const wsBadge = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '-');
            md.appendMarkdown(`| ${a.statusIcon} **${a.name}** | \`${wsBadge}\` | \`${a.status}\` | \`${a.id}\` |\n`);
        }
        md.appendMarkdown(`\n*Click to open Agent Command Palette*`);
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
                { label: '$(rocket) Launch Agent in Git Worktree...', action: 'worktree' },
                { label: '$(terminal) Launch Herdr Terminal', action: 'terminal' },
                { label: '$(refresh) Refresh Agents', action: 'refresh' }
            ], {
                title: 'Herdr Collie HUD',
                placeHolder: 'No active AI agents detected in current session'
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
                description: a.isBlocked ? `⚠️ Input Needed (${a.id})` : `(${a.id})`,
                detail: a.isBlocked 
                    ? '⚠️ Waiting for confirmation! Click to respond or focus.' 
                    : (a.isWorking ? '🟢 Agent is actively processing tasks...' : '🟡 Agent is idle and ready for instructions.'),
                agent: a,
                buttons: [
                    {
                        iconPath: new vscode.ThemeIcon('terminal'),
                        tooltip: 'Attach / Focus Terminal'
                    },
                    {
                        iconPath: new vscode.ThemeIcon('comment'),
                        tooltip: 'Send Prompt to Agent'
                    },
                    ...(a.isBlocked ? [{
                        iconPath: new vscode.ThemeIcon('check'),
                        tooltip: 'Quick Approve (y)'
                    }] : [])
                ]
            };
        });

        const qp = vscode.window.createQuickPick<AgentQuickPickItem>();
        qp.title = `Herdr Collie Agent HUD (${this.getSessionName()})`;
        qp.placeholder = 'Select an agent to interact with';
        qp.items = items;

        qp.onDidTriggerItemButton(async (e) => {
            qp.hide();
            const targetAgent = e.item.agent;
            const tooltip = e.button.tooltip;

            if (tooltip === 'Quick Approve (y)') {
                await this.sendKeysToAgent(targetAgent.id, ['y', 'enter']);
                vscode.window.showInformationMessage(`Sent 'y' to '${targetAgent.name}'`);
                this.refresh();
            } else if (tooltip === 'Send Prompt to Agent') {
                const prompt = await vscode.window.showInputBox({
                    title: `Prompt Agent: ${targetAgent.name}`,
                    prompt: 'Enter instructions for the agent'
                });
                if (prompt && prompt.trim()) {
                    if (this.socketClient.isConnected) {
                        try {
                            await this.socketClient.sendAgentPrompt(targetAgent.id, prompt.trim());
                            vscode.window.showInformationMessage(`Prompt sent to '${targetAgent.name}'`);
                            this.refresh();
                            return;
                        } catch {
                            // Fallback to CLI
                        }
                    }
                    execHerdr(['--session', sessionName, 'agent', 'prompt', targetAgent.id, prompt.trim()], () => {
                        vscode.window.showInformationMessage(`Prompt sent to '${targetAgent.name}'`);
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
        this.statusBarItem.dispose();
    }
}
