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

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapResultRecord(raw: unknown): JsonRecord | null {
    if (!isRecord(raw)) {
        return null;
    }
    return isRecord(raw.result) ? raw.result : raw;
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string'
        ? value
        : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback);
}

/**
 * Returns the first candidate convertible to a non-empty string (preserving numeric 0 and booleans).
 */
function firstNonEmptyString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value === 'string') {
            if (value !== '') {
                return value;
            }
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
    }
    return '';
}

export interface RawSnapshotInput {
    tabs?: readonly unknown[];
    workspaces?: readonly unknown[];
    panes?: readonly unknown[];
    agents?: readonly unknown[];
    focused_tab_id?: string;
    focused_workspace_id?: string;
}

/**
 * Parse stdout of `herdr session list --json`
 */
export function parseSessions(stdout: string): HerdrSessionInfo[] {
    try {
        const data: unknown = JSON.parse(stdout);
        const result = unwrapResultRecord(data);
        const rawSessions = result && Array.isArray(result.sessions) ? result.sessions : [];

        return rawSessions
            .filter(isRecord)
            .map((s): HerdrSessionInfo => ({
                name: asString(s.name),
                isDefault: Boolean(s.default),
                running: Boolean(s.running),
                sessionDir: s.session_dir ? asString(s.session_dir) : undefined,
                socketPath: s.socket_path ? asString(s.socket_path) : undefined
            }))
            .filter((s) => s.name.length > 0);
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
        const data: unknown = JSON.parse(stdout);
        const result = unwrapResultRecord(data);
        const rawWorkspaces = result && Array.isArray(result.workspaces) ? result.workspaces : [];

        return rawWorkspaces.map((wsRaw): ParsedWorkspace | null => {
            if (!isRecord(wsRaw)) {
                const fallbackId = asString(wsRaw);
                if (!fallbackId) return null;
                const wsPanes = panes.filter(p => p.workspaceId === fallbackId);
                const cwd = wsPanes.length > 0 ? (wsPanes[0].cwd || '') : '';
                return {
                    id: fallbackId,
                    label: cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() || cwd) : `Workspace ${fallbackId}`,
                    cwd,
                    focused: false
                };
            }

            const id = firstNonEmptyString(wsRaw.workspace_id, wsRaw.name, wsRaw.id);
            const wsPanes = panes.filter(p => p.workspaceId === id);
            const cwd = wsPanes.length > 0 ? (wsPanes[0].cwd || '') : asString(wsRaw.cwd);

            const explicitLabel = wsRaw.label ? asString(wsRaw.label) : '';
            let label = explicitLabel;
            if (!label) {
                if (homedir && cwd === homedir) {
                    label = '~';
                } else if (cwd) {
                    label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
                } else {
                    label = `Workspace ${firstNonEmptyString(wsRaw.number, id)}`;
                }
            }

            return {
                id,
                label,
                cwd,
                focused: Boolean(wsRaw.focused)
            };
        }).filter((ws): ws is ParsedWorkspace => ws !== null);
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
        const data: unknown = JSON.parse(stdout);
        const result = unwrapResultRecord(data);
        const rawAgents = result && Array.isArray(result.agents) ? result.agents : [];

        return rawAgents.filter(isRecord).map((a) => {
            const id = firstNonEmptyString(a.pane_id, a.id, a.name, 'Unknown');
            const name = firstNonEmptyString(a.name, a.agent, id);
            const rawStatus = firstNonEmptyString(a.agent_status, a.status, 'idle');
            const info = classifyAgentStatus(rawStatus);

            let workspaceId = a.workspace_id ? asString(a.workspace_id) : undefined;
            if (!workspaceId && id.includes(':')) {
                workspaceId = id.split(':')[0];
            }

            const matchedWs = workspaces.find(w => w.id === workspaceId);
            const workspaceLabel = matchedWs ? matchedWs.label : (workspaceId ? `Workspace ${workspaceId}` : undefined);
            const directCwd = firstNonEmptyString(a.workspace_cwd, a.cwd);
            const workspaceCwd = (matchedWs && matchedWs.cwd) ? matchedWs.cwd : (directCwd || undefined);
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

function parsePaneRecord(p: JsonRecord): ParsedPane {
    const pane: ParsedPane = {
        id: firstNonEmptyString(p.pane_id, p.id),
        name: firstNonEmptyString(p.name, p.pane_id),
        command: asString(p.command),
        workspaceId: asString(p.workspace_id),
        cwd: firstNonEmptyString(p.foreground_cwd, p.cwd)
    };
    if (p.tab_id) {
        pane.tabId = asString(p.tab_id);
    }
    return pane;
}

/**
 * Parse stdout of `herdr pane list`
 */
export function parsePanes(stdout: string): ParsedPane[] {
    try {
        const data: unknown = JSON.parse(stdout);
        const result = unwrapResultRecord(data);
        const rawPanes = result && Array.isArray(result.panes) ? result.panes : [];

        return rawPanes.filter(isRecord).map(parsePaneRecord);
    } catch {
        return [];
    }
}

/**
 * Parse structured snapshot object into ParsedPane array
 */
export function parseSnapshotPanes(
    snapshot: Pick<RawSnapshotInput, 'panes'> | null | undefined
): ParsedPane[] {
    if (!snapshot || !Array.isArray(snapshot.panes)) return [];
    return snapshot.panes.filter(isRecord).map(parsePaneRecord);
}

/**
 * Parse stdout of `herdr tab list`
 */
export function parseTabs(stdout: string): ParsedTab[] {
    try {
        const data: unknown = JSON.parse(stdout);
        const result = unwrapResultRecord(data);
        const rawTabs = result && Array.isArray(result.tabs) ? result.tabs : [];

        return rawTabs.filter(isRecord).map((t) => ({
            id: firstNonEmptyString(t.tab_id, t.id),
            workspaceId: asString(t.workspace_id),
            label: firstNonEmptyString(t.label, t.number, 'Tab'),
            number: typeof t.number === 'number' ? t.number : undefined,
            focused: Boolean(t.focused),
            paneCount: typeof t.pane_count === 'number' ? t.pane_count : 1,
            agentStatus: t.agent_status ? asString(t.agent_status) : undefined
        }));
    } catch {
        return [];
    }
}

/**
 * Parse structured snapshot object into ParsedTab array
 */
export function parseSnapshotTabs(
    snapshot: Pick<RawSnapshotInput, 'tabs' | 'focused_tab_id'> | null | undefined
): ParsedTab[] {
    if (!snapshot || !Array.isArray(snapshot.tabs)) return [];
    const focusedTabId = snapshot.focused_tab_id || '';

    return snapshot.tabs.filter(isRecord).map(t => {
        const id = firstNonEmptyString(t.tab_id, t.id);
        const isFocused = Boolean(t.focused) || (focusedTabId !== '' && focusedTabId === id);
        return {
            id,
            workspaceId: asString(t.workspace_id),
            label: firstNonEmptyString(t.label, t.number, 'Tab'),
            number: typeof t.number === 'number' ? t.number : undefined,
            focused: isFocused,
            paneCount: typeof t.pane_count === 'number' ? t.pane_count : 1,
            agentStatus: t.agent_status ? asString(t.agent_status) : undefined
        };
    });
}

/**
 * Parse structured snapshot object into ParsedWorkspace array
 */
export function parseSnapshotWorkspaces(
    snapshot: Pick<RawSnapshotInput, 'workspaces' | 'panes' | 'focused_workspace_id'> | null | undefined,
    homedir = ''
): ParsedWorkspace[] {
    if (!snapshot || !Array.isArray(snapshot.workspaces)) return [];

    const panes = Array.isArray(snapshot.panes) ? snapshot.panes.filter(isRecord) : [];
    const focusedId = snapshot.focused_workspace_id || '';

    return snapshot.workspaces.filter(isRecord).map(ws => {
        const id = firstNonEmptyString(ws.workspace_id, ws.name, ws.id);
        const wsPanes = panes.filter(p => p.workspace_id === id);
        const cwd = wsPanes.length > 0
            ? firstNonEmptyString(wsPanes[0].foreground_cwd, wsPanes[0].cwd)
            : asString(ws.cwd);

        const explicitLabel = ws.label ? asString(ws.label) : '';
        let label = explicitLabel;
        if (!label) {
            if (homedir && cwd === homedir) {
                label = '~';
            } else if (cwd) {
                label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
            } else {
                label = `Workspace ${firstNonEmptyString(ws.number, id)}`;
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
    snapshot: Pick<RawSnapshotInput, 'agents' | 'panes' | 'workspaces' | 'focused_workspace_id'> | null | undefined,
    workspaces: ParsedWorkspace[] = []
): ParsedAgent[] {
    if (!snapshot) return [];

    const wsList = workspaces.length > 0 ? workspaces : parseSnapshotWorkspaces(snapshot);
    const panes = Array.isArray(snapshot.panes) ? snapshot.panes.filter(isRecord) : [];

    let rawAgents: JsonRecord[] = [];
    if (Array.isArray(snapshot.agents) && snapshot.agents.length > 0) {
        rawAgents = snapshot.agents.filter(isRecord);
    } else if (panes.length > 0) {
        rawAgents = panes
            .filter(p => p.agent_status && p.agent_status !== 'unknown')
            .map(p => ({
                id: p.pane_id,
                name: p.name || p.pane_id,
                status: p.agent_status,
                workspace_id: p.workspace_id
            }));
    }

    return rawAgents.map(a => {
        const id = firstNonEmptyString(a.pane_id, a.id, a.name, 'Unknown');
        const name = firstNonEmptyString(a.name, a.agent, id);
        const rawStatus = firstNonEmptyString(a.agent_status, a.status, 'idle');
        const info = classifyAgentStatus(rawStatus);

        let workspaceId = a.workspace_id ? asString(a.workspace_id) : undefined;
        if (!workspaceId && id.includes(':')) {
            workspaceId = id.split(':')[0];
        }

        const matchedWs = wsList.find(w => w.id === workspaceId);
        const matchedPane = panes.find(p => p.pane_id === id);
        const paneCwd = matchedPane ? firstNonEmptyString(matchedPane.foreground_cwd, matchedPane.cwd) : '';

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

export type IntegrationState = 'current' | 'outdated' | 'not_installed';

export interface ParsedIntegrationInfo {
    target: string;
    cliTarget: string;
    socketTarget: string;
    label: string;
    command: string;
    available: boolean;
    state: IntegrationState;
    experimental?: boolean;
    details?: string;
    path?: string;
}

const CLI_TARGET_ALIASES: Record<string, string> = {
    'antigravity_cli': 'antigravity-cli',
    'agy': 'antigravity-cli',
    'cursor-agent': 'cursor',
    'gh copilot': 'copilot'
};

const SOCKET_TARGET_ALIASES: Record<string, string> = {
    'antigravity-cli': 'antigravity_cli',
    'agy': 'antigravity_cli',
    'cursor-agent': 'cursor',
    'gh copilot': 'copilot'
};

/**
 * Normalizes an agent/integration identifier to the Herdr CLI `integration install <TARGET>` name.
 */
export function normalizeIntegrationTargetForCli(target: string): string {
    const trimmed = (target || '').trim().toLowerCase();
    if (!trimmed) return '';
    return CLI_TARGET_ALIASES[trimmed] || trimmed.replace(/_/g, '-');
}

/**
 * Normalizes an agent/integration identifier to the Herdr socket API `IntegrationTarget` enum name.
 */
export function normalizeIntegrationTargetForSocket(target: string): string {
    const trimmed = (target || '').trim().toLowerCase();
    if (!trimmed) return '';
    return SOCKET_TARGET_ALIASES[trimmed] || trimmed.replace(/-/g, '_');
}

/**
 * Maps an agent command string (e.g. `claude --flag`, `gh copilot`, `agy`) to its Herdr integration target.
 */
export function mapAgentCmdToIntegrationTarget(agentCmd: string): string | undefined {
    const trimmed = (agentCmd || '').trim();
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('gh copilot')) return 'copilot';
    const firstToken = lower.split(/\s+/)[0].replace(/^.*[\\/]/, '');
    if (!firstToken) return undefined;
    return normalizeIntegrationTargetForCli(firstToken);
}

/**
 * Parses `herdr integration status` CLI output into structured integration entries.
 */
export function parseIntegrationStatus(stdout: string): ParsedIntegrationInfo[] {
    if (!stdout || !stdout.trim()) return [];

    const results: ParsedIntegrationInfo[] = [];
    const lines = stdout.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx <= 0) continue;

        const left = line.slice(0, colonIdx).trim();
        let right = line.slice(colonIdx + 1).trim();

        const targetMatch = left.match(/^([a-zA-Z0-9_-]+)(?:\s+\((experimental)\))?$/i);
        if (!targetMatch) continue;

        const rawTarget = targetMatch[1];
        const experimental = Boolean(targetMatch[2]);

        let hookPath: string | undefined;
        const pathMatch = right.match(/\s+\(((?:\/|~|[a-zA-Z]:[\\/])[^)]+)\)$/);
        if (pathMatch) {
            hookPath = pathMatch[1].trim();
            right = right.slice(0, pathMatch.index).trim();
        }

        const lowerRight = right.toLowerCase();
        let state: IntegrationState = 'current';
        if (lowerRight.includes('not installed') || lowerRight.includes('not_installed')) {
            state = 'not_installed';
        } else if (lowerRight.includes('outdated') || lowerRight.includes('legacy')) {
            state = 'outdated';
        }

        const cliTarget = normalizeIntegrationTargetForCli(rawTarget);
        const socketTarget = normalizeIntegrationTargetForSocket(rawTarget);

        results.push({
            target: cliTarget,
            cliTarget,
            socketTarget,
            label: rawTarget,
            command: cliTarget === 'antigravity-cli' ? 'agy' : (cliTarget === 'cursor' ? 'cursor-agent' : cliTarget),
            available: state !== 'not_installed',
            state,
            experimental,
            details: right || undefined,
            path: hookPath
        });
    }

    return results;
}

/**
 * Parses socket API `integration.list` response payload into structured integration entries.
 */
export function parseIntegrationListResult(result: unknown): ParsedIntegrationInfo[] {
    const rawList: unknown[] = isRecord(result) && Array.isArray(result.integrations)
        ? result.integrations
        : (Array.isArray(result) ? result : []);

    const results: ParsedIntegrationInfo[] = [];
    for (const item of rawList) {
        if (!isRecord(item)) continue;
        const rawTarget = asString(item.target).trim();
        if (!rawTarget) continue;

        const rawState = asString(item.state, 'not_installed').toLowerCase();
        let state: IntegrationState = 'not_installed';
        if (rawState === 'current' || rawState === 'installed') {
            state = 'current';
        } else if (rawState === 'outdated') {
            state = 'outdated';
        }

        const cliTarget = normalizeIntegrationTargetForCli(rawTarget);
        const socketTarget = normalizeIntegrationTargetForSocket(rawTarget);

        results.push({
            target: cliTarget,
            cliTarget,
            socketTarget,
            label: firstNonEmptyString(item.label, rawTarget),
            command: firstNonEmptyString(item.command, cliTarget),
            available: Boolean(item.available),
            state
        });
    }
    return results;
}
