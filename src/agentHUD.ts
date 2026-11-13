/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { HerdrSocketClient } from './socketClient';
import { ParsedAgent, AgentStatusType, parseSnapshotAgents, parseAgents, extractCleanOutputSummary } from './parsers';
import { execHerdr } from './executors';
import { formatWorkspaceProblems, formatDurationCompact } from './formatters';

export type AutoVerifyMode = 'prompt' | 'auto' | 'off';

export interface AutoVerifyDiagnosticsSummary {
    totalErrors: number;
    fileCount: number;
    problemsByFile: { [file: string]: { line: number; severity: 'Error' | 'Warning'; message: string }[] };
}

function normalizePathForMatch(p?: string): string {
    if (!p) return '';
    let normalized = path.normalize(p).replace(/[\/\\]+$/, '');
    if (process.platform === 'win32' || process.platform === 'darwin') {
        normalized = normalized.toLowerCase();
    }
    return normalized;
}

/**
 * Collects Error-severity diagnostics from VS Code Language Server, optionally scoped to an agent's workspace CWD
 */
export function collectWorkspaceErrorsForAgent(agentCwd?: string): AutoVerifyDiagnosticsSummary {
    const problemsByFile: { [file: string]: { line: number; severity: 'Error' | 'Warning'; message: string }[] } = {};
    let totalErrors = 0;
    let fileCount = 0;

    if (!vscode || !vscode.languages || typeof vscode.languages.getDiagnostics !== 'function') {
        return { totalErrors: 0, fileCount: 0, problemsByFile };
    }

    let allDiagnostics: any[];
    try {
        allDiagnostics = vscode.languages.getDiagnostics() as any[];
    } catch {
        return { totalErrors: 0, fileCount: 0, problemsByFile };
    }

    if (!Array.isArray(allDiagnostics)) {
        return { totalErrors: 0, fileCount: 0, problemsByFile };
    }

    const cwdNorm = normalizePathForMatch(agentCwd);
    const hasAbsoluteCwd = Boolean(agentCwd && path.isAbsolute(agentCwd));

    for (const entry of allDiagnostics) {
        if (!Array.isArray(entry) || entry.length < 2 || !entry[0] || !Array.isArray(entry[1])) {
            continue;
        }
        const [uri, fileDiagnostics] = entry;
        if (fileDiagnostics.length === 0) continue;

        const fsPath: string = typeof uri === 'string' ? uri : (uri.fsPath || uri.path || '');
        if (hasAbsoluteCwd && fsPath && path.isAbsolute(fsPath)) {
            const fileNorm = normalizePathForMatch(fsPath);
            if (fileNorm !== cwdNorm && !fileNorm.startsWith(cwdNorm + path.sep)) {
                continue;
            }
        }

        const errorSeverity = vscode.DiagnosticSeverity ? vscode.DiagnosticSeverity.Error : 0;
        const errors = fileDiagnostics.filter((d: any) => d && (d.severity === errorSeverity || d.severity === 0));
        if (errors.length === 0) continue;

        let relPath = '';
        if (hasAbsoluteCwd && agentCwd && fsPath && path.isAbsolute(fsPath)) {
            const candidate = path.relative(agentCwd, fsPath).replace(/\\/g, '/');
            if (candidate && !candidate.startsWith('..')) {
                relPath = candidate;
            }
        }
        if (!relPath) {
            relPath = (vscode.workspace && typeof vscode.workspace.asRelativePath === 'function')
                ? vscode.workspace.asRelativePath(uri)
                : (fsPath ? path.basename(fsPath) : 'unknown');
        }

        problemsByFile[relPath] = errors.map((d: any) => ({
            line: (d.range?.start?.line ?? 0) + 1,
            severity: 'Error' as const,
            message: String(d.message || '')
        }));

        totalErrors += errors.length;
        fileCount++;
    }

    return { totalErrors, fileCount, problemsByFile };
}

/**
 * Formats collected workspace error diagnostics into a closed-loop verification prompt for the agent
 */
export function formatAutoVerifyDiagnosticsPrompt(
    summary: AutoVerifyDiagnosticsSummary,
    attempt?: number,
    maxRetries?: number
): string {
    if (!summary || summary.totalErrors === 0) {
        return '';
    }
    const basePrompt = formatWorkspaceProblems(summary.problemsByFile);
    if (!basePrompt) {
        return '';
    }
    if (attempt !== undefined && maxRetries !== undefined) {
        return `[Auto-Verify Loop ${attempt}/${maxRetries}] ${basePrompt}`;
    }
    return basePrompt;
}

/**
 * Safely escapes markdown characters and eliminates newlines for markdown table cells
 */
export function escapeMarkdownTableCell(str: string): string {
    if (!str) return '-';
    return str
        .replace(/[\r\n]+/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/`/g, "'")
        .replace(/[\[\]]/g, '')
        .trim() || '-';
}

export class AgentHUD implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private previousAgentStates: Map<string, { status: string; statusType: AgentStatusType; name: string; isWorking: boolean; isBlocked: boolean; workspaceId?: string; statusChangedAt: number; latestOutput?: string }> = new Map();
    private autoVerifyRetryCounts: Map<string, number> = new Map();
    private isDisposed = false;
    private notifiedBlockedAgents: Set<string> = new Set();
    private refreshSequence = 0;
    private _onDidChangeBlockedCount = new vscode.EventEmitter<number>();
    public readonly onDidChangeBlockedCount = this._onDidChangeBlockedCount.event;
    private currentBlockedCount = 0;
    private connectListener?: () => void;
    private eventListener?: (event: any) => void;
    private disconnectListener?: () => void;
    private eventRefreshTimer: NodeJS.Timeout | null = null;

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
        this.statusBarItem.name = 'Herdr Collie Agent HUD';
        this.updateHUDText([]);
        this.statusBarItem.show();

        this.setupSocketEvents(this.socketClient);
    }

    public updateSocketClient(newSocketClient: HerdrSocketClient): void {
        this.cleanupSocketEvents();
        this.socketClient = newSocketClient;
        this.setupSocketEvents(this.socketClient);
        this.refresh();
    }

    private scheduleEventRefresh(delayMs: number = 30): void {
        if (this.isDisposed) return;
        if (this.eventRefreshTimer) {
            clearTimeout(this.eventRefreshTimer);
        }
        this.eventRefreshTimer = setTimeout(() => {
            this.eventRefreshTimer = null;
            void this.refresh({ maxAgeMs: 150 });
        }, delayMs);
    }

    private setupSocketEvents(client: HerdrSocketClient): void {
        this.connectListener = () => this.refresh();
        this.eventListener = (event: any) => {
            this.handleSocketEvent(event);
            this.scheduleEventRefresh(30);
        };
        this.disconnectListener = () => {
            if (this.eventRefreshTimer) {
                clearTimeout(this.eventRefreshTimer);
                this.eventRefreshTimer = null;
            }
            this.updateHUDText([]);
        };

        client.on('connect', this.connectListener);
        client.on('event', this.eventListener);
        client.on('disconnect', this.disconnectListener);
        client.on('error', () => {});
    }

    private cleanupSocketEvents(): void {
        if (this.eventRefreshTimer) {
            clearTimeout(this.eventRefreshTimer);
            this.eventRefreshTimer = null;
        }
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

    private handleSocketEvent(event: any): void {
        if (!event) return;
        // Check for direct agent notification event structures if present
        if (event.event === 'agent.blocked' || (event.agent_status && (event.agent_status === 'blocked' || event.agent_status === 'waiting'))) {
            const agentId = event.pane_id || event.id || event.agent;
            const agentName = event.name || agentId;
            const prev = agentId ? this.previousAgentStates.get(agentId) : undefined;
            const workspaceId = event.workspace_id || event.workspaceId || event.workspace || prev?.workspaceId;
            const rawOut = event.last_output ?? event.latest_output ?? event.summary ?? event.last_line ?? event.message;
            const latestOutput = typeof rawOut === 'string' ? extractCleanOutputSummary(rawOut) : prev?.latestOutput;
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
                        isBlocked: true,
                        workspaceId: workspaceId,
                        statusChangedAt: prev?.statusType === 'blocked' ? prev.statusChangedAt : Date.now(),
                        ...(latestOutput !== undefined ? { latestOutput } : {})
                    });
                }
            }
        }
    }

    /**
     * Enriches parsed agents with tracked state transition timestamps and latest output summaries
     */
    public enrichAgentsWithStateMetadata(agents: ParsedAgent[], nowMs: number = Date.now()): ParsedAgent[] {
        return agents.map(agent => {
            const prev = this.previousAgentStates.get(agent.id);
            const statusChangedAt = typeof agent.statusChangedAt === 'number'
                ? agent.statusChangedAt
                : (prev && prev.statusType === agent.statusType ? prev.statusChangedAt : nowMs);
            const latestOutput = agent.latestOutput ?? prev?.latestOutput;
            return {
                ...agent,
                statusChangedAt,
                ...(latestOutput !== undefined ? { latestOutput } : {})
            };
        });
    }

    /**
     * Refreshes agents list and updates HUD & notifications
     */
    public async refresh(options?: { maxAgeMs?: number }): Promise<void> {
        if (this.isDisposed) return;

        const seq = ++this.refreshSequence;
        let agents: ParsedAgent[] = [];

        if (this.socketClient.isConnected) {
            const snapshot = await this.socketClient.getSnapshot(options?.maxAgeMs ?? 0);
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
    private processAgentStateTransitions(currentAgents: ParsedAgent[], nowMs: number = Date.now()): void {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        const enableNotifications = config.get<boolean>('agentHUD.enableNotifications', true);

        for (const agent of currentAgents) {
            const prev = this.previousAgentStates.get(agent.id);
            const statusChangedAt = typeof agent.statusChangedAt === 'number'
                ? agent.statusChangedAt
                : (prev && prev.statusType === agent.statusType ? prev.statusChangedAt : nowMs);
            const latestOutput = agent.latestOutput ?? prev?.latestOutput;

            agent.statusChangedAt = statusChangedAt;
            if (latestOutput !== undefined) {
                agent.latestOutput = latestOutput;
            }

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
            if (prev && prev.isWorking && agent.statusType === 'done') {
                this.handleAgentDoneTransition(agent, enableNotifications);
            }

            this.previousAgentStates.set(agent.id, {
                status: agent.status,
                statusType: agent.statusType,
                name: agent.name,
                isWorking: agent.isWorking,
                isBlocked: agent.isBlocked,
                workspaceId: agent.workspaceId,
                statusChangedAt,
                latestOutput
            });
        }

        // Clean up removed agents
        const currentIds = new Set(currentAgents.map(a => a.id));
        for (const id of Array.from(this.previousAgentStates.keys())) {
            if (!currentIds.has(id)) {
                this.previousAgentStates.delete(id);
                this.notifiedBlockedAgents.delete(id);
                this.autoVerifyRetryCounts.delete(id);
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

        const baseMessage = l10n.t("🤖 Agent '{0}' requires input / confirmation:", agent.name);
        const warningText = agent.latestOutput
            ? `${baseMessage} "${agent.latestOutput}"`
            : baseMessage;

        const action = await vscode.window.showWarningMessage(
            warningText,
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
            vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName, agent.workspaceId);
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
     * Closed-loop verification gate when an agent transitions from working to done
     */
    private async handleAgentDoneTransition(agent: ParsedAgent, enableNotifications: boolean): Promise<void> {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        const rawMode = config.get<string>('agentHUD.autoVerifyDiagnostics', 'prompt');
        const mode: AutoVerifyMode = (rawMode === 'auto' || rawMode === 'off' || rawMode === 'prompt') ? rawMode : 'prompt';

        if (mode === 'off') {
            this.autoVerifyRetryCounts.delete(agent.id);
            if (enableNotifications) {
                await this.triggerDoneNotification(agent);
            }
            return;
        }

        const summary = collectWorkspaceErrorsForAgent(agent.workspaceCwd);
        if (summary.totalErrors === 0) {
            this.autoVerifyRetryCounts.delete(agent.id);
            if (enableNotifications) {
                await this.triggerDoneNotification(agent);
            }
            return;
        }

        if (mode === 'auto') {
            const rawMaxRetries = config.get<number>('agentHUD.autoVerifyMaxRetries', 2);
            const maxRetries = Math.max(1, Math.min(5, typeof rawMaxRetries === 'number' ? rawMaxRetries : 2));
            const currentRetries = this.autoVerifyRetryCounts.get(agent.id) || 0;

            if (currentRetries < maxRetries) {
                const attempt = currentRetries + 1;
                this.autoVerifyRetryCounts.set(agent.id, attempt);
                const prompt = formatAutoVerifyDiagnosticsPrompt(summary, attempt, maxRetries);
                await this.sendPromptToAgent(agent.id, prompt, agent.workspaceCwd);
                if (enableNotifications) {
                    vscode.window.showInformationMessage(
                        l10n.t("🔄 Auto-Verify ({0}/{1}): Sent {2} remaining error(s) back to '{3}'", attempt, maxRetries, summary.totalErrors, agent.name)
                    );
                }
                return;
            }

            // Circuit breaker reached: reset counter and escalate to human prompt
            this.autoVerifyRetryCounts.delete(agent.id);
        }

        if (enableNotifications) {
            await this.triggerDoneWithErrorsNotification(agent, summary);
        }
    }

    /**
     * Displays completion notification when no diagnostic errors remain (or verification is off)
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
            vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName, agent.workspaceId);
        }
    }

    /**
     * Displays interactive warning notification when agent finishes with remaining workspace errors
     */
    private async triggerDoneWithErrorsNotification(agent: ParsedAgent, summary: AutoVerifyDiagnosticsSummary): Promise<void> {
        const sessionName = this.getSessionName();
        const sendErrorsBtn = l10n.t('Send Errors to Agent ({0})', summary.totalErrors);
        const focusBtn = l10n.t('Focus Terminal');
        const dismissBtn = l10n.t('Dismiss');

        const action = await vscode.window.showWarningMessage(
            l10n.t("⚠️ Agent '{0}' finished, but {1} error(s) remain in workspace.", agent.name, summary.totalErrors),
            sendErrorsBtn,
            focusBtn,
            dismissBtn
        );

        if (action === sendErrorsBtn) {
            const prompt = formatAutoVerifyDiagnosticsPrompt(summary);
            await this.sendPromptToAgent(agent.id, prompt, agent.workspaceCwd);
            vscode.window.showInformationMessage(
                l10n.t("Sent {0} diagnostic error(s) back to '{1}'", summary.totalErrors, agent.name)
            );
        } else if (action === focusBtn) {
            vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName, agent.workspaceId);
        }
    }

    /**
     * Sends a prompt string to an agent via socket or CLI fallback
     */
    private async sendPromptToAgent(agentId: string, prompt: string, cwd?: string): Promise<boolean> {
        if (this.socketClient.isConnected) {
            try {
                await this.socketClient.sendAgentPrompt(agentId, prompt);
                return true;
            } catch {
                // Fallback to CLI if socket fails
            }
        }

        const session = this.getSessionName();
        const sessionArgs = session ? ['--session', session] : [];
        return new Promise<boolean>((resolve) => {
            execHerdr([...sessionArgs, 'agent', 'prompt', agentId, prompt], { cwd }, (err: any) => {
                if (err) {
                    execHerdr([...sessionArgs, 'pane', 'send-text', agentId, prompt], { cwd }, (fbErr: any) => {
                        resolve(!fbErr);
                    });
                } else {
                    resolve(true);
                }
            });
        });
    }

    public getAutoVerifyRetryCount(agentId: string): number {
        return this.autoVerifyRetryCounts.get(agentId) || 0;
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
    private updateHUDText(agents: ParsedAgent[], nowMs: number = Date.now()): void {
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
        // Do not enable isTrusted to prevent command URI injection attacks
        md.appendMarkdown(`### ` + l10n.t('Herdr Agents ({0} active)', agents.length) + `\n\n`);
        md.appendMarkdown(`| ${l10n.t('Agent')} | ${l10n.t('Workspace')} | ${l10n.t('Status')} | ${l10n.t('Pane ID')} |\n`);
        md.appendMarkdown(`| :--- | :--- | :--- | :--- |\n`);
        for (const a of agents) {
            const wsBadge = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '-');
            const durationStr = (typeof a.statusChangedAt === 'number' && nowMs >= a.statusChangedAt)
                ? formatDurationCompact(nowMs - a.statusChangedAt)
                : '';
            const statusText = durationStr ? `${a.status} (${durationStr})` : a.status;
            const safeName = escapeMarkdownTableCell(a.name);
            const safeWs = escapeMarkdownTableCell(wsBadge);
            const safeStatus = escapeMarkdownTableCell(statusText);
            const safeId = escapeMarkdownTableCell(a.id);
            md.appendMarkdown(`| ${a.statusIcon} **${safeName}** | \`${safeWs}\` | \`${safeStatus}\` | \`${safeId}\` |\n`);
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

        const nowMs = Date.now();
        agents = this.enrichAgentsWithStateMetadata(agents, nowMs);

        interface AgentQuickPickItem extends vscode.QuickPickItem {
            agent: ParsedAgent;
        }

        const items: AgentQuickPickItem[] = agents.map(a => {
            const wsBadge = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
            const agentTitle = a.name && a.name !== a.id ? a.name : 'Agent';
            const label = wsBadge ? `${a.statusIcon} [${wsBadge}] ${agentTitle}` : `${a.statusIcon} ${agentTitle}`;
            const durationStr = (typeof a.statusChangedAt === 'number' && nowMs >= a.statusChangedAt)
                ? formatDurationCompact(nowMs - a.statusChangedAt)
                : '';
            const description = a.isBlocked
                ? `⚠️ ` + l10n.t('Input Needed') + (durationStr ? ` (${durationStr})` : '') + ` (${a.id})`
                : (durationStr ? `${durationStr} • (${a.id})` : `(${a.id})`);
            const baseDetail = a.isBlocked
                ? l10n.t('⚠️ Waiting for confirmation! Click to respond or focus.')
                : (a.isWorking ? l10n.t('🟢 Agent is actively processing tasks...') : l10n.t('🟡 Agent is idle and ready for instructions.'));
            const detail = a.latestOutput ? `${baseDetail} — "${a.latestOutput}"` : baseDetail;

            return {
                label,
                description,
                detail,
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
                vscode.commands.executeCommand('herdr-collie.attachWorkspace', targetAgent.id, true, this.getAgentDisplayName(targetAgent), sessionName, targetAgent.workspaceId);
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
                vscode.commands.executeCommand('herdr-collie.attachWorkspace', agent.id, true, this.getAgentDisplayName(agent), sessionName, agent.workspaceId);
            }
        });

        qp.onDidHide(() => {
            qp.dispose();
        });

        qp.show();
    }

    public dispose(): void {
        this.isDisposed = true;
        this.cleanupSocketEvents();
        this._onDidChangeBlockedCount.dispose();
        this.statusBarItem.dispose();
    }
}
