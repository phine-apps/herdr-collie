import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { ParsedAgent, ParsedWorkspace, GitWorktreeInfo } from './parsers';

export interface ProblemItem {
    file: string;
    line: number;
    severity: 'Error' | 'Warning';
    message: string;
}

/**
 * Safely generates a markdown code block by calculating a fence that exceeds
 * any internal backtick sequence, preventing prompt injection or fence breakout.
 */
export function formatCodeFence(code: string, lang: string = ''): string {
    const text = code ?? '';
    const backtickMatches = text.match(/`+/g) || [];
    let maxBackticks = 2;
    for (const match of backtickMatches) {
        if (match.length > maxBackticks) {
            maxBackticks = match.length;
        }
    }
    const fence = '`'.repeat(Math.max(3, maxBackticks + 1));
    return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * Format active code selection context into Markdown
 */
export function formatSelectionContext(
    fileName: string, 
    startLine: number, 
    endLine: number, 
    languageId: string, 
    codeText: string
): string {
    const lineInfo = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
    return `\`${fileName}\` (${lineInfo}):\n${formatCodeFence(codeText, languageId)}`;
}

/**
 * Format diagnostics for a single active document
 */
export function formatFileDiagnostics(
    fileName: string, 
    diagnostics: { line: number; message: string }[]
): string {
    if (diagnostics.length === 0) {
        return '';
    }
    const errorLines = diagnostics.map(d => `Line ${d.line}: ${d.message}`).join('\n');
    return `The following errors are present in \`${fileName}\`:\n${formatCodeFence(errorLines)}\nPlease fix them.`;
}

/**
 * Format workspace-wide problems into Markdown
 */
export function formatWorkspaceProblems(
    problemsByFile: { [file: string]: { line: number; severity: 'Error' | 'Warning'; message: string }[] }
): string {
    const errorLines: string[] = [];
    
    for (const [file, issues] of Object.entries(problemsByFile)) {
        if (!issues || issues.length === 0) continue;
        errorLines.push(`### \`${file}\``);
        for (const issue of issues) {
            errorLines.push(`- **Line ${issue.line}** [${issue.severity}]: ${issue.message}`);
        }
        errorLines.push('');
    }

    if (errorLines.length === 0) {
        return '';
    }

    return `Here are the current problems (errors/warnings) across the workspace:\n\n${errorLines.join('\n')}\n\nPlease help me fix these issues.`;
}

/**
 * Format staged/working tree git diff output into Markdown
 */
export function formatGitDiff(diffText: string, targetFile?: string, isStaged = false): string {
    const truncatedDiff = diffText.length > 50000 ? diffText.substring(0, 50000) + '\n... (truncated)' : diffText;
    const diffType = isStaged ? 'staged git diff' : 'working tree (unstaged) git diff';
    const fileSpecifier = targetFile ? ` for \`${targetFile}\`` : '';
    const action = isStaged ? 'Please review these staged changes.' : 'Please review these changes.';
    return `Here is the ${diffType}${fileSpecifier}:\n${formatCodeFence(truncatedDiff, 'diff')}\n${action}`;
}

/**
 * Format branch context information
 */
export function formatBranchContext(branchName: string, recentCommits: string): string {
    return `Here is the context for the current Git branch:\n\n**Current Branch:** \`${branchName}\`\n\n**Recent Commits:**\n${formatCodeFence(recentCommits.trim())}\n\nPlease keep this context in mind.`;
}

/**
 * Format symbol hover information
 */
export function formatHoverInfo(symbolName: string, hoverContents: string[]): string {
    const joined = hoverContents.filter(c => c.trim().length > 0).join('\n\n');
    return `Here is the type and documentation info for \`${symbolName}\`:\n\n${joined.trim()}\n\nPlease keep this API/type definition in mind.`;
}

/**
 * Format terminal output or error logs into Markdown
 */
export function formatTerminalOutput(
    terminalName: string, 
    outputText: string, 
    command?: string, 
    exitCode?: number
): string {
    const trimmed = outputText.trim();
    if (!trimmed) {
        return '';
    }

    const truncated = trimmed.length > 50000 ? trimmed.substring(0, 50000) + '\n... (truncated)' : trimmed;
    
    let header = `Here is the terminal output from \`${terminalName}\`:\n`;
    if (command) {
        header = `Here is the terminal output for command \`${command}\` (Terminal: \`${terminalName}\`):\n`;
    }

    let statusLine = '';
    let instruction = 'Please review this terminal output.';
    if (exitCode !== undefined) {
        if (exitCode !== 0) {
            statusLine = `\n**Exit Code:** \`${exitCode}\` (Execution failed)\n`;
            instruction = 'Please analyze this terminal failure/error and help me fix the issue.';
        } else {
            statusLine = `\n**Exit Code:** \`0\` (Success)\n`;
        }
    }

    return `${header}${statusLine}\n${formatCodeFence(truncated)}\n\n${instruction}`;
}

export interface StatusThemeIcon {
    id: string;
    color?: string;
}

/**
 * Maps rolled-up agent status to VS Code ThemeIcon id and color for workspaces:
 * - 🔴 Blocked: circle-filled with charts.red
 * - 🟡 Idle/Waiting: circle-filled with charts.yellow
 * - 🟢 Working: circle-filled with charts.green
 * - ⚪ Done/Other: circle-filled with charts.gray
 * - None: circle-outline with disabledForeground (consistent alignment for inactive workspaces)
 */
export function getWorkspaceStatusThemeIcon(statusIcon?: string): StatusThemeIcon {
    switch (statusIcon) {
        case '🔴':
            return { id: 'circle-filled', color: 'charts.red' };
        case '🟡':
            return { id: 'circle-filled', color: 'charts.yellow' };
        case '🟢':
            return { id: 'circle-filled', color: 'charts.green' };
        case '⚪':
            return { id: 'circle-filled', color: 'charts.gray' };
        default:
            return { id: 'circle-outline', color: 'disabledForeground' };
    }
}

/**
 * Maps agent status to VS Code ThemeIcon id and color:
 * - Blocked / 🔴: circle-filled with charts.red
 * - 🟡 Idle: circle-filled with charts.yellow
 * - 🟢 Working: circle-filled with charts.green
 * - ⚪ Done/Other: circle-filled with charts.gray
 */
export function getAgentStatusThemeIcon(statusIcon?: string, isBlocked?: boolean): StatusThemeIcon {
    if (isBlocked || statusIcon === '🔴') {
        return { id: 'circle-filled', color: 'charts.red' };
    }
    switch (statusIcon) {
        case '🟡':
            return { id: 'circle-filled', color: 'charts.yellow' };
        case '🟢':
            return { id: 'circle-filled', color: 'charts.green' };
        case '⚪':
            return { id: 'circle-filled', color: 'charts.gray' };
        default:
            return { id: 'circle-outline', color: 'disabledForeground' };
    }
}

/**
 * Maps rolled-up agent status to SVG icon filename in media/icons/:
 * - 🔴 Blocked: status-red.svg
 * - 🟡 Idle/Waiting: status-yellow.svg
 * - 🟢 Working: status-green.svg
 * - ⚪ Done/Other: status-gray.svg
 * - None: status-none.svg
 */
export function getWorkspaceStatusIconFile(statusIcon?: string): string {
    switch (statusIcon) {
        case '🔴':
            return 'status-red.svg';
        case '🟡':
            return 'status-yellow.svg';
        case '🟢':
            return 'status-green.svg';
        case '⚪':
            return 'status-gray.svg';
        default:
            return 'status-none.svg';
    }
}

/**
 * Maps agent status to SVG icon filename in media/icons/:
 * - Blocked / 🔴: status-red.svg
 * - 🟡 Idle: status-yellow.svg
 * - 🟢 Working: status-green.svg
 * - ⚪ Done/Other: status-gray.svg
 * - None: status-none.svg
 */
export function getAgentStatusIconFile(statusIcon?: string, isBlocked?: boolean): string {
    if (isBlocked || statusIcon === '🔴') {
        return 'status-red.svg';
    }
    switch (statusIcon) {
        case '🟡':
            return 'status-yellow.svg';
        case '🟢':
            return 'status-green.svg';
        case '⚪':
            return 'status-gray.svg';
        default:
            return 'status-none.svg';
    }
}

export interface WorkspaceDisplayInfo {
    label: string;
    displayLabel: string;
    statusIcon?: string;
    statusThemeIcon: StatusThemeIcon;
    statusIconFile: string;
    description: string;
    tooltip: string;
    iconId: string;
    isFocused: boolean;
    isCurrentWindow: boolean;
    isWorktree: boolean;
    branchName?: string;
    agentBadges?: string;
    matchedAgents: ParsedAgent[];
}

/**
 * Returns the highest priority status icon for a group of agents, matching Herdr's attention priority:
 * 1. 🔴 Blocked (attention needed immediately)
 * 2. 🟡 Idle / Waiting (ready for prompt / finished task)
 * 3. 🟢 Working (actively running)
 * 4. ⚪ Done / other
 */
export function getAggregateStatusIcon(agents: ParsedAgent[]): string | undefined {
    if (!agents || agents.length === 0) {
        return undefined;
    }
    const priorityOrder: ('🔴' | '🟡' | '🟢' | '⚪')[] = ['🔴', '🟡', '🟢', '⚪'];
    for (const icon of priorityOrder) {
        if (agents.some(a => a.statusIcon === icon)) {
            return icon;
        }
    }
    return agents[0]?.statusIcon || '⚪';
}

export function normalizePathForComparison(p?: string): string {
    if (!p) return '';
    let normalized = path.normalize(p).replace(/[\/\\]+$/, '');
    if (!normalized && p.trim()) {
        normalized = path.sep;
    }
    if (process.platform === 'win32' || process.platform === 'darwin') {
        normalized = normalized.toLowerCase();
    }
    return normalized;
}

/**
 * Checks whether candidatePath equals basePath or is strictly inside basePath directory.
 */
export function isSameOrSubPath(candidatePath?: string, basePath?: string): boolean {
    const candidateNorm = normalizePathForComparison(candidatePath);
    const baseNorm = normalizePathForComparison(basePath);
    if (!candidateNorm || !baseNorm) {
        return false;
    }
    if (candidateNorm === baseNorm) {
        return true;
    }
    const prefix = baseNorm.endsWith(path.sep) ? baseNorm : `${baseNorm}${path.sep}`;
    return candidateNorm.startsWith(prefix);
}

/**
 * Finds an existing Herdr workspace matching the current VS Code project directory.
 * Prefers normalized cwd equality (preserving matches across workspace renames while
 * avoiding collisions on identical basenames in different directories), falling back
 * to id match or label match when cwd is unavailable.
 */
export function findMatchingWorkspaceForCwd(
    workspaces: ParsedWorkspace[],
    currentCwd?: string,
    wsName?: string
): ParsedWorkspace | undefined {
    const normCurrent = normalizePathForComparison(currentCwd);
    if (normCurrent) {
        const byCwd = workspaces.find(w => {
            const wsCwd = normalizePathForComparison(w.cwd);
            return Boolean(wsCwd) && wsCwd === normCurrent;
        });
        if (byCwd) {
            return byCwd;
        }
    }

    return workspaces.find(w =>
        (Boolean(currentCwd) && w.id === currentCwd) ||
        (!w.cwd && Boolean(wsName) && w.label === wsName)
    );
}

/**
 * Format workspace display information for TreeView, QuickPick, HUD, and tooltips
 */
export function formatWorkspaceDisplay(
    ws: ParsedWorkspace,
    worktrees: GitWorktreeInfo[] = [],
    agents: ParsedAgent[] = [],
    currentWorkspaceFolder?: string
): WorkspaceDisplayInfo {
    const wsCwdNorm = normalizePathForComparison(ws.cwd);
    const matchedWt = wsCwdNorm ? worktrees.find(w => normalizePathForComparison(w.worktree) === wsCwdNorm) : undefined;
    const isWorktree = Boolean(matchedWt && !matchedWt.isMain);
    const branchName = matchedWt?.branch;

    const isCurrentWindow = isSameOrSubPath(ws.cwd, currentWorkspaceFolder);
    const isFocused = Boolean(ws.focused);

    // Filter agents associated with this workspace
    const wsAgents = agents.filter(a => 
        a.workspaceId === ws.id || 
        (a.workspaceLabel && a.workspaceLabel === ws.label) || 
        (wsCwdNorm && a.workspaceCwd && normalizePathForComparison(a.workspaceCwd) === wsCwdNorm)
    );

    // Roll-up agent status to workspace
    const statusIcon = getAggregateStatusIcon(wsAgents);
    const statusThemeIcon = getWorkspaceStatusThemeIcon(statusIcon);
    const label = ws.label;

    // Build agent badges:
    // - If 1 or 2 agents: show names and icons: "claude 🟢, cursor 🟡"
    // - If 3 or more agents: aggregate by status count prioritizing urgency: "🔴 1, 🟢 2, 🟡 1"
    let agentBadges = '';
    if (wsAgents.length > 0 && wsAgents.length <= 2) {
        agentBadges = wsAgents.map(a => `${a.name || 'Agent'} ${a.statusIcon}`).join(', ');
    } else if (wsAgents.length > 2) {
        const iconCounts = new Map<string, number>();
        for (const a of wsAgents) {
            const icon = a.statusIcon || '⚪';
            iconCounts.set(icon, (iconCounts.get(icon) || 0) + 1);
        }
        const priorityOrder = ['🔴', '🟢', '🟡', '⚪'];
        const sortedIcons = Array.from(iconCounts.keys()).sort((a, b) => {
            const idxA = priorityOrder.indexOf(a);
            const idxB = priorityOrder.indexOf(b);
            const orderA = idxA === -1 ? 999 : idxA;
            const orderB = idxB === -1 ? 999 : idxB;
            return orderA - orderB;
        });
        agentBadges = sortedIcons.map(icon => `${icon} ${iconCounts.get(icon)}`).join(', ');
    }

    // Build concise description: only show branch (if worktree) and agentBadges
    const descParts: string[] = [];
    if (isWorktree && branchName) {
        descParts.push(`(${branchName})`);
    }
    if (agentBadges) {
        descParts.push(`[${agentBadges}]`);
    } else if (!isWorktree && ws.cwd) {
        descParts.push(ws.cwd);
    } else if (!isWorktree) {
        descParts.push(`ID: ${ws.id}`);
    }

    const description = descParts.join(' • ');

    // Build rich tooltip
    const tooltipLines: string[] = [
        `Workspace: ${ws.label}${isFocused ? ' (Active in Herdr)' : ''}`
    ];
    if (ws.cwd) {
        tooltipLines.push(`Path: ${ws.cwd}`);
    }
    if (branchName) {
        tooltipLines.push(`Branch: ${branchName}${isWorktree ? ' (Git Worktree)' : ''}`);
    }
    if (isCurrentWindow) {
        tooltipLines.push(`VS Code Window: Matches current open folder`);
    }
    tooltipLines.push(`Workspace ID: ${ws.id}`);

    if (wsAgents.length > 0) {
        tooltipLines.push(`\nActive Agents (${wsAgents.length}):`);
        for (const a of wsAgents) {
            tooltipLines.push(`- ${a.statusIcon} ${a.name} (${a.status})`);
        }
    } else {
        tooltipLines.push(`\nActive Agents: (None)`);
    }

    const tooltip = tooltipLines.join('\n');

    // Determine icon
    let iconId = 'window';
    if (isWorktree) {
        iconId = 'git-branch';
    } else if (isCurrentWindow) {
        iconId = 'folder-active';
    }

    const statusIconFile = getWorkspaceStatusIconFile(statusIcon);

    return {
        label,
        displayLabel: ws.label,
        statusIcon,
        statusThemeIcon,
        statusIconFile,
        description,
        tooltip,
        iconId,
        isFocused,
        isCurrentWindow,
        isWorktree,
        branchName,
        agentBadges: agentBadges || undefined,
        matchedAgents: wsAgents
    };
}

export interface AgentDisplayInfo {
    label: string;
    agentName: string;
    statusThemeIcon: StatusThemeIcon;
    statusIconFile: string;
    description: string;
    tooltip: string;
    displayLabel: string;
    wsBadge: string;
    branchName?: string;
    durationText?: string;
}

/**
 * Formats an elapsed millisecond duration into a compact human-readable string (e.g. "45s", "2m 5s", "1h 15m")
 */
export function formatDurationCompact(elapsedMs: number): string {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 1000) {
        return '0s';
    }
    const totalSeconds = Math.floor(elapsedMs / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60) {
        return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Format agent display information for TreeView, QuickPick, and tooltips (matching Herdr TUI convention)
 */
export function formatAgentDisplay(
    agent: ParsedAgent,
    worktrees: GitWorktreeInfo[] = [],
    nowMs: number = Date.now()
): AgentDisplayInfo {
    const agentCwdNorm = normalizePathForComparison(agent.workspaceCwd);
    const matchedWt = agentCwdNorm ? worktrees.find(w => normalizePathForComparison(w.worktree) === agentCwdNorm) : undefined;
    const branchName = matchedWt?.branch;
    const wsName = agent.workspaceLabel || (agent.workspaceId ? `Workspace ${agent.workspaceId}` : '');

    const branchPart = branchName ? `(${branchName})` : '';
    const wsBadge = wsName && branchPart ? `${wsName} ${branchPart}` : (wsName || branchPart);

    const agentName = agent.name && agent.name !== agent.id ? agent.name : 'Agent';
    const label = `${agent.statusIcon} ${agentName}`;
    const statusThemeIcon = getAgentStatusThemeIcon(agent.statusIcon, agent.isBlocked);
    const statusIconFile = getAgentStatusIconFile(agent.statusIcon, agent.isBlocked);

    const durationText = (typeof agent.statusChangedAt === 'number' && nowMs >= agent.statusChangedAt)
        ? formatDurationCompact(nowMs - agent.statusChangedAt)
        : undefined;

    let description = '';
    if (agent.isBlocked) {
        const inputNeeded = durationText
            ? `${l10n.t('Input Needed')} (${durationText})`
            : l10n.t('Input Needed');
        description = wsBadge ? `${inputNeeded} • ${wsBadge}` : `${inputNeeded} (${agent.id})`;
    } else {
        const baseDesc = wsBadge || `(${agent.id})`;
        description = durationText ? `${baseDesc} • ${durationText}` : baseDesc;
    }

    if (agent.latestOutput) {
        description = `${description} • ${agent.latestOutput}`;
    }

    const tooltipLines: string[] = [
        `Agent: ${agentName}`,
        `Workspace: ${agent.workspaceLabel || (agent.workspaceId ? `Workspace ${agent.workspaceId}` : 'Unknown')}`
    ];
    if (branchName) {
        tooltipLines.push(`Branch: ${branchName}`);
    }
    if (agent.workspaceCwd) {
        tooltipLines.push(`Path: ${agent.workspaceCwd}`);
    }
    tooltipLines.push(`Pane ID: ${agent.id}`);
    const statusWithDuration = durationText ? `${agent.status} (${durationText})` : agent.status;
    tooltipLines.push(`Status: ${statusWithDuration}${agent.isBlocked ? '\n⚠️ Waiting for user confirmation' : ''}`);
    if (agent.latestOutput) {
        tooltipLines.push(`Latest Output: ${agent.latestOutput}`);
    }

    const tooltip = tooltipLines.join('\n');
    const displayLabel = `${agentName} [${wsBadge || agent.id}]`;

    const result: AgentDisplayInfo = {
        label,
        agentName,
        statusThemeIcon,
        statusIconFile,
        description,
        tooltip,
        displayLabel,
        wsBadge,
        branchName
    };
    if (durationText !== undefined) {
        result.durationText = durationText;
    }
    return result;
}

export type AgentSortOrder = 'grouped' | 'priority';

/**
 * Sorts agents by workspace group (grouped) or attention queue urgency (priority)
 */
export function sortAgents(
    agents: ParsedAgent[], 
    sortOrder: AgentSortOrder = 'grouped'
): ParsedAgent[] {
    const list = [...agents];

    if (sortOrder === 'priority') {
        const priorityScore = (agent: ParsedAgent): number => {
            if (agent.isBlocked || agent.statusType === 'blocked') return 0;
            if (agent.isWorking || agent.statusType === 'working') return 1;
            if (agent.statusType === 'idle') return 2;
            if (agent.statusType === 'done') return 3;
            return 4;
        };

        return list.sort((a, b) => {
            const scoreA = priorityScore(a);
            const scoreB = priorityScore(b);
            if (scoreA !== scoreB) {
                return scoreA - scoreB;
            }
            const wsA = a.workspaceLabel || a.workspaceId || '';
            const wsB = b.workspaceLabel || b.workspaceId || '';
            if (wsA !== wsB) {
                return wsA.localeCompare(wsB);
            }
            return a.id.localeCompare(b.id);
        });
    }

    // 'grouped' sort: Group by workspace, then pane ID / agent name
    return list.sort((a, b) => {
        const wsA = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
        const wsB = b.workspaceLabel || (b.workspaceId ? `Workspace ${b.workspaceId}` : '');
        if (wsA !== wsB) {
            return wsA.localeCompare(wsB);
        }
        return a.id.localeCompare(b.id);
    });
}

