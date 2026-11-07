/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */

export interface HerdrSessionInfo {
    name: string;
    isDefault: boolean;
    running: boolean;
    sessionDir?: string;
    socketPath?: string;
}

export interface ParsedWorkspace {
    id: string;
    label: string;
    cwd: string;
    focused: boolean;
    session?: string;
}

export type AgentStatusType = 'working' | 'blocked' | 'idle' | 'done' | 'unknown';

export interface ParsedAgent {
    id: string;
    name: string;
    status: string;
    statusType: AgentStatusType;
    statusIcon: '🟢' | '🟡' | '🔴' | '⚪';
    isWorking: boolean;
    isBlocked: boolean;
    workspaceId?: string;
    workspaceLabel?: string;
    workspaceCwd?: string;
    session?: string;
    statusChangedAt?: number;
    latestOutput?: string;
}

/**
 * Strips ANSI escape codes and extracts the last meaningful non-empty line as a compact summary
 */
export function extractCleanOutputSummary(rawText?: string, maxLength = 80): string | undefined {
    if (!rawText || typeof rawText !== 'string') {
        return undefined;
    }

    // Strip ANSI escape sequences and control characters (preserving newlines)
    const stripped = rawText
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    const lines = stripped
        .split(/\r?\n/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => line.length > 0);

    if (lines.length === 0) {
        return undefined;
    }

    // Prefer the last line that contains alphanumeric/CJK characters rather than pure box-drawing or punctuation
    let chosen = lines[lines.length - 1];
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/[\p{L}\p{N}]/u.test(lines[i])) {
            chosen = lines[i];
            break;
        }
    }

    if (chosen.length > maxLength) {
        return chosen.slice(0, Math.max(1, maxLength - 3)).trimEnd() + '...';
    }
    return chosen;
}

export interface GitWorktreeInfo {
    worktree: string;
    head: string;
    branch?: string;
    bare?: boolean;
    detached?: boolean;
    locked?: boolean;
    prunable?: boolean;
    isMain?: boolean;
}

export interface ParsedPane {
    id: string;
    name: string;
    command: string;
    workspaceId: string;
    cwd: string;
    tabId?: string;
    session?: string;
}

export interface ParsedTab {
    id: string;
    workspaceId: string;
    label: string;
    number?: number;
    focused: boolean;
    paneCount: number;
    agentStatus?: string;
}

/**
 * Parse stdout of `herdr session list --json`
 */
export function parseSessions(stdout: string): HerdrSessionInfo[] {
    try {
        const data = JSON.parse(stdout);
        const result = data.result || data;
        const rawSessions = Array.isArray(result.sessions) ? result.sessions : [];

        return rawSessions.map((s: any) => ({
            name: String(s.name || ''),
            isDefault: Boolean(s.default),
            running: Boolean(s.running),
            sessionDir: s.session_dir ? String(s.session_dir) : undefined,
            socketPath: s.socket_path ? String(s.socket_path) : undefined
        })).filter((s: HerdrSessionInfo) => s.name.length > 0);
    } catch {
        return [];
    }
}

/**
 * Parse stdout of `herdr workspace list`
 */
export function parseWorkspaces(
    stdout: string, 
    panes: ParsedPane[] = [], 
    homedir = ''
): ParsedWorkspace[] {
    try {
        const data = JSON.parse(stdout);
        const result = data.result || data;
        const rawWorkspaces = Array.isArray(result.workspaces) ? result.workspaces : [];

        return rawWorkspaces.map((ws: any) => {
            const id = String(ws.workspace_id || ws.name || ws.id || ws);
            const wsPanes = panes.filter(p => p.workspaceId === id);
            let cwd = wsPanes.length > 0 ? (wsPanes[0].cwd || '') : (ws.cwd || '');
            
            const explicitLabel = ws.label ? String(ws.label) : '';
            let label = explicitLabel;
            if (!label) {
                if (homedir && cwd === homedir) {
                    label = '~';
                } else if (cwd) {
                    label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
                } else {
                    label = `Workspace ${ws.number || id}`;
                }
            }

            return {
                id,
                label,
                cwd,
                focused: Boolean(ws.focused)
            };
        });
    } catch {
        return [];
    }
}

/**
 * Classifies raw agent status string into structured category and icon
 */
export function classifyAgentStatus(statusRaw: string): {
    status: string;
    statusType: AgentStatusType;
    statusIcon: '🟢' | '🟡' | '🔴' | '⚪';
    isWorking: boolean;
    isBlocked: boolean;
} {
    const status = String(statusRaw || 'idle').toLowerCase();
    
    if (status === 'running' || status === 'working' || status === 'executing' || status === 'busy') {
        return {
            status,
            statusType: 'working',
            statusIcon: '🟢',
            isWorking: true,
            isBlocked: false
        };
    }
    
    if (status === 'blocked' || status === 'waiting' || status === 'prompt' || status === 'needs_input' || status === 'needs_attention' || status === 'confirm') {
        return {
            status,
            statusType: 'blocked',
            statusIcon: '🔴',
            isWorking: false,
            isBlocked: true
        };
    }

    if (status === 'done' || status === 'completed' || status === 'finished' || status === 'success') {
        return {
            status,
            statusType: 'done',
            statusIcon: '⚪',
            isWorking: false,
            isBlocked: false
        };
    }

    return {
        status,
        statusType: 'idle',
        statusIcon: '🟡',
        isWorking: false,
        isBlocked: false
    };
}

/**
 * Parse stdout of `herdr agent list`
 */
export function parseAgents(
    stdout: string, 
    workspaces: ParsedWorkspace[] = []
): ParsedAgent[] {
    try {
        const data = JSON.parse(stdout);
        const result = data.result || data;
        const rawAgents = Array.isArray(result.agents) ? result.agents : [];

        return rawAgents.map((a: any) => {
            const id = String(a.pane_id || a.id || a.name || 'Unknown');
            const name = String(a.name || a.agent || id);
            const rawStatus = String(a.agent_status || a.status || 'idle');
            const info = classifyAgentStatus(rawStatus);

            let workspaceId = a.workspace_id ? String(a.workspace_id) : undefined;
            if (!workspaceId && id.includes(':')) {
                workspaceId = id.split(':')[0];
            }

            const matchedWs = workspaces.find(w => w.id === workspaceId);
            const workspaceLabel = matchedWs ? matchedWs.label : (workspaceId ? `Workspace ${workspaceId}` : undefined);
            const workspaceCwd = matchedWs ? matchedWs.cwd : undefined;
            const rawOutput = a.last_output ?? a.latest_output ?? a.summary ?? a.last_line ?? a.output;
            const latestOutput = typeof rawOutput === 'string' ? extractCleanOutputSummary(rawOutput) : undefined;

            const parsed: ParsedAgent = {
                id,
                name,
                status: info.status,
                statusType: info.statusType,
                statusIcon: info.statusIcon,
                isWorking: info.isWorking,
                isBlocked: info.isBlocked,
                workspaceId,
                workspaceLabel,
                workspaceCwd
            };
            if (latestOutput !== undefined) {
                parsed.latestOutput = latestOutput;
            }
            return parsed;
        });
    } catch {
        return [];
    }
}

/**
 * Parse stdout of `herdr pane list`
 */
export function parsePanes(stdout: string): ParsedPane[] {
    try {
        const data = JSON.parse(stdout);
        const result = data.result || data;
        const rawPanes = Array.isArray(result.panes) ? result.panes : [];

        return rawPanes.map((p: any) => {
            const pane: ParsedPane = {
                id: String(p.pane_id || p.id || ''),
                name: String(p.name || p.pane_id || ''),
                command: String(p.command || ''),
                workspaceId: String(p.workspace_id || ''),
                cwd: String(p.foreground_cwd || p.cwd || '')
            };
            if (p.tab_id) {
                pane.tabId = String(p.tab_id);
            }
            return pane;
        });
    } catch {
        return [];
    }
}

/**
 * Parse stdout of `herdr tab list`
 */
export function parseTabs(stdout: string): ParsedTab[] {
    try {
        const data = JSON.parse(stdout);
        const result = data.result || data;
        const rawTabs = Array.isArray(result.tabs) ? result.tabs : [];

        return rawTabs.map((t: any) => ({
            id: String(t.tab_id || t.id || ''),
            workspaceId: String(t.workspace_id || ''),
            label: String(t.label || t.number || 'Tab'),
            number: typeof t.number === 'number' ? t.number : undefined,
            focused: Boolean(t.focused),
            paneCount: typeof t.pane_count === 'number' ? t.pane_count : 1,
            agentStatus: t.agent_status ? String(t.agent_status) : undefined
        }));
    } catch {
        return [];
    }
}

/**
 * Parse structured snapshot object into ParsedTab array
 */
export function parseSnapshotTabs(
    snapshot: { tabs?: any[]; focused_tab_id?: string } | null
): ParsedTab[] {
    if (!snapshot || !Array.isArray(snapshot.tabs)) return [];
    const focusedTabId = snapshot.focused_tab_id || '';

    return snapshot.tabs.map(t => {
        const id = String(t.tab_id || t.id || '');
        const isFocused = Boolean(t.focused) || (focusedTabId !== '' && focusedTabId === id);
        return {
            id,
            workspaceId: String(t.workspace_id || ''),
            label: String(t.label || t.number || 'Tab'),
            number: typeof t.number === 'number' ? t.number : undefined,
            focused: isFocused,
            paneCount: typeof t.pane_count === 'number' ? t.pane_count : 1,
            agentStatus: t.agent_status ? String(t.agent_status) : undefined
        };
    });
}

/**
 * Parse structured snapshot object into ParsedWorkspace array
 */
export function parseSnapshotWorkspaces(
    snapshot: { workspaces?: any[]; panes?: any[]; focused_workspace_id?: string } | null, 
    homedir = ''
): ParsedWorkspace[] {
    if (!snapshot || !Array.isArray(snapshot.workspaces)) return [];

    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
    const focusedId = snapshot.focused_workspace_id || '';

    return snapshot.workspaces.map(ws => {
        const id = String(ws.workspace_id || ws.name || ws.id || '');
        const wsPanes = panes.filter(p => p.workspace_id === id);
        let cwd = wsPanes.length > 0 ? (wsPanes[0].foreground_cwd || wsPanes[0].cwd || '') : (ws.cwd || '');
        
        const explicitLabel = ws.label ? String(ws.label) : '';
        let label = explicitLabel;
        if (!label) {
            if (homedir && cwd === homedir) {
                label = '~';
            } else if (cwd) {
                label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
            } else {
                label = `Workspace ${ws.number || id}`;
            }
        }

        const isFocused = Boolean(ws.focused) || (focusedId !== '' && focusedId === id);

        return {
            id,
            label,
            cwd,
            focused: isFocused
        };
    });
}

/**
 * Parse structured snapshot object into ParsedAgent array
 */
export function parseSnapshotAgents(
    snapshot: { agents?: any[]; panes?: any[]; workspaces?: any[]; focused_workspace_id?: string } | null,
    workspaces: ParsedWorkspace[] = []
): ParsedAgent[] {
    if (!snapshot) return [];

    const wsList = workspaces.length > 0 ? workspaces : parseSnapshotWorkspaces(snapshot);

    let rawAgents: any[] = [];
    if (Array.isArray(snapshot.agents) && snapshot.agents.length > 0) {
        rawAgents = snapshot.agents;
    } else if (Array.isArray(snapshot.panes)) {
        // Extract agent info from panes if present
        rawAgents = snapshot.panes
            .filter(p => p.agent_status && p.agent_status !== 'unknown')
            .map(p => ({
                id: p.pane_id,
                name: p.name || p.pane_id,
                status: p.agent_status,
                workspace_id: p.workspace_id
            }));
    }

    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];

    return rawAgents.map(a => {
        const id = String(a.pane_id || a.id || a.name || 'Unknown');
        const name = String(a.name || a.agent || id);
        const rawStatus = String(a.agent_status || a.status || 'idle');
        const info = classifyAgentStatus(rawStatus);

        let workspaceId = a.workspace_id ? String(a.workspace_id) : undefined;
        if (!workspaceId && id.includes(':')) {
            workspaceId = id.split(':')[0];
        }

        const matchedWs = wsList.find(w => w.id === workspaceId);
        const matchedPane = panes.find(p => p.pane_id === id);
        const paneCwd = matchedPane ? (matchedPane.foreground_cwd || matchedPane.cwd || '') : '';

        const workspaceLabel = matchedWs ? matchedWs.label : (workspaceId ? `Workspace ${workspaceId}` : undefined);
        const workspaceCwd = matchedWs?.cwd || (paneCwd || undefined);
        const rawOutput = a.last_output ?? a.latest_output ?? a.summary ?? a.last_line ?? a.output ??
            (matchedPane ? (matchedPane.last_output ?? matchedPane.latest_output ?? matchedPane.summary ?? matchedPane.last_line) : undefined);
        const latestOutput = typeof rawOutput === 'string' ? extractCleanOutputSummary(rawOutput) : undefined;

        const parsed: ParsedAgent = {
            id,
            name,
            status: info.status,
            statusType: info.statusType,
            statusIcon: info.statusIcon,
            isWorking: info.isWorking,
            isBlocked: info.isBlocked,
            workspaceId,
            workspaceLabel,
            workspaceCwd
        };
        if (latestOutput !== undefined) {
            parsed.latestOutput = latestOutput;
        }
        return parsed;
    });
}

/**
 * Parse stdout of `git worktree list --porcelain`
 */
export function parseGitWorktrees(stdout: string): GitWorktreeInfo[] {
    if (!stdout || !stdout.trim()) return [];
    
    const worktrees: GitWorktreeInfo[] = [];
    const entries = stdout.trim().split(/\n\n+/);

    for (const entry of entries) {
        if (!entry.trim()) continue;
        const lines = entry.split('\n');
        const current: Partial<GitWorktreeInfo> = {};

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('worktree ')) {
                current.worktree = trimmed.substring('worktree '.length).trim();
            } else if (trimmed.startsWith('HEAD ')) {
                current.head = trimmed.substring('HEAD '.length).trim();
            } else if (trimmed.startsWith('branch ')) {
                const fullBranch = trimmed.substring('branch '.length).trim();
                current.branch = fullBranch.replace(/^refs\/heads\//, '');
            } else if (trimmed === 'bare') {
                current.bare = true;
            } else if (trimmed === 'detached') {
                current.detached = true;
            } else if (trimmed.startsWith('locked')) {
                current.locked = true;
            } else if (trimmed.startsWith('prunable')) {
                current.prunable = true;
            }
        }

        if (current.worktree && current.head) {
            current.isMain = (worktrees.length === 0);
            worktrees.push(current as GitWorktreeInfo);
        }
    }

    return worktrees;
}
