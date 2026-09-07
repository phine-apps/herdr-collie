import { ParsedAgent, GitWorktreeInfo } from './parsers';

export interface ProblemItem {
    file: string;
    line: number;
    severity: 'Error' | 'Warning';
    message: string;
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
    return `\`${fileName}\` (${lineInfo}):\n\`\`\`${languageId}\n${codeText}\n\`\`\``;
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
    return `The following errors are present in \`${fileName}\`:\n\`\`\`\n${errorLines}\n\`\`\`\nPlease fix them.`;
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
    return `Here is the ${diffType}${fileSpecifier}:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n${action}`;
}

/**
 * Format branch context information
 */
export function formatBranchContext(branchName: string, recentCommits: string): string {
    return `Here is the context for the current Git branch:\n\n**Current Branch:** \`${branchName}\`\n\n**Recent Commits:**\n\`\`\`\n${recentCommits.trim()}\n\`\`\`\n\nPlease keep this context in mind.`;
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

    return `${header}${statusLine}\n\`\`\`\n${truncated}\n\`\`\`\n\n${instruction}`;
}

export interface AgentDisplayInfo {
    label: string;
    description: string;
    tooltip: string;
    displayLabel: string;
    wsBadge: string;
    branchName?: string;
}

/**
 * Format agent display information for TreeView, QuickPick, and tooltips (matching Herdr TUI convention)
 */
export function formatAgentDisplay(
    agent: ParsedAgent,
    worktrees: GitWorktreeInfo[] = []
): AgentDisplayInfo {
    const matchedWt = agent.workspaceCwd ? worktrees.find(w => w.worktree === agent.workspaceCwd) : undefined;
    const branchName = matchedWt?.branch;
    const wsName = agent.workspaceLabel || (agent.workspaceId ? `Workspace ${agent.workspaceId}` : '');

    let wsBadge = wsName;
    if (branchName) {
        wsBadge = wsName ? `${wsName} (${branchName})` : branchName;
    }

    const agentName = agent.name && agent.name !== agent.id ? agent.name : 'Agent';
    const label = wsBadge ? `${agent.statusIcon} [${wsBadge}] ${agentName}` : `${agent.statusIcon} ${agentName}`;
    const description = agent.isBlocked ? `⚠️ Input Needed (${agent.id})` : `(${agent.id})`;

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
    tooltipLines.push(`Status: ${agent.status}${agent.isBlocked ? '\n⚠️ Waiting for user confirmation' : ''}`);

    const tooltip = tooltipLines.join('\n');
    const displayLabel = `${agentName} [${wsBadge || agent.id}]`;

    return {
        label,
        description,
        tooltip,
        displayLabel,
        wsBadge,
        branchName
    };
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

