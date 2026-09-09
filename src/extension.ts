import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execHerdr, runGitCmd, ensureSessionServerRunning } from './executors';
import {
    formatSelectionContext,
    formatFileDiagnostics,
    formatWorkspaceProblems,
    formatGitDiff,
    formatBranchContext,
    formatHoverInfo,
    formatTerminalOutput,
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
    parseSessions,
    GitWorktreeInfo
} from './parsers';
import { HerdrSocketClient, validateSessionName } from './socketClient';
import { setupConfigManager } from './configManager';
import { AgentHUD } from './agentHUD';
import { WorkspaceHUD } from './workspaceHUD';
import { 
    launchWorktreeAgentWizard, 
    listGitWorktrees, 
    getRepoRoot, 
    removeWorktree, 
    mergeWorktreeBranch 
} from './worktreeManager';
import { HerdrWorkspaceTreeItem, WorkspaceDragAndDropController } from './workspaceDragAndDrop';

interface TargetQuickPickItem extends vscode.QuickPickItem {
    targetId: string;
    sessionName?: string;
    isAgent?: boolean;
    displayLabel?: string;
}

function getSessionName(): string {
    const config = vscode.workspace.getConfiguration('herdr-collie');
    return config.get<string>('sessionName', 'vscode') || 'vscode';
}

function fetchActiveSessions(): Promise<string[]> {
    const configuredSession = getSessionName();
    return new Promise((resolve) => {
        execHerdr(['session', 'list', '--json'], (err: any, stdout: any) => {
            if (!err && stdout) {
                const sessions = parseSessions(stdout);
                if (sessions.length > 0) {
                    const sessionNames = sessions.map(s => s.name);
                    if (!sessionNames.includes(configuredSession)) {
                        sessionNames.push(configuredSession);
                    }
                    resolve(sessionNames);
                    return;
                }
            }
            const fallback = ['default'];
            if (configuredSession && !fallback.includes(configuredSession)) {
                fallback.push(configuredSession);
            }
            resolve(fallback);
        });
    });
}

async function getWorktreesForCwds(cwds: (string | undefined)[]): Promise<GitWorktreeInfo[]> {
    const validCwds = Array.from(new Set(cwds.filter((c): c is string => Boolean(c))));
    const allWorktrees: GitWorktreeInfo[] = [];
    const visitedRepos = new Set<string>();

    for (const cwd of validCwds) {
        try {
            const repoRoot = await getRepoRoot(cwd);
            if (repoRoot && !visitedRepos.has(repoRoot)) {
                visitedRepos.add(repoRoot);
                const wts = await listGitWorktrees(repoRoot);
                allWorktrees.push(...wts);
            }
        } catch {
            // Ignore git inspection errors for non-git paths
        }
    }

    for (const wf of vscode.workspace.workspaceFolders || []) {
        try {
            const repoRoot = await getRepoRoot(wf.uri.fsPath);
            if (repoRoot && !visitedRepos.has(repoRoot)) {
                visitedRepos.add(repoRoot);
                const wts = await listGitWorktrees(repoRoot);
                allWorktrees.push(...wts);
            }
        } catch {
            // Ignore git inspection errors
        }
    }

    return allWorktrees;
}

export function activate(context: vscode.ExtensionContext) {
    // Ensure session server is running in background
    const initialSession = getSessionName();
    ensureSessionServerRunning(initialSession).catch(() => {});

    // Setup Herdr embedded config to hide sidebar in VS Code terminal if enabled
    setupConfigManager(context);

    let activeSidebarSession = getSessionName();
    const getActiveSidebarSession = () => activeSidebarSession;

    let socketClient = new HerdrSocketClient(activeSidebarSession);
    socketClient.connect();

    let refreshAllProviders: () => void = () => {};

    async function openOrAttachTerminal(target: string, isAgent: boolean, displayLabel: string, targetSession: string) {
        // Manage a single unified Herdr TUI terminal per session
        const sessionLabel = targetSession ? ` (${targetSession})` : '';
        const baseTerminalName = `Herdr${sessionLabel}`;
        const terminalName = baseTerminalName;

        // Focus the target in Herdr background beforehand
        if (target) {
            if (isAgent) {
                // Focus the specific agent pane
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', targetSession, 'agent', 'focus', target], () => resolve());
                });
            } else {
                // Focus the specific workspace
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', targetSession, 'workspace', 'focus', target], () => resolve());
                });
            }
        }

        // Check if an existing terminal is present
        const existingTerminal = vscode.window.terminals.find(t => 
            t.name === baseTerminalName || 
            t.name.startsWith(`Herdr Workspace${sessionLabel}:`) || 
            t.name.startsWith(`Herdr Agent${sessionLabel}:`)
        );

        if (existingTerminal) {
            existingTerminal.show();
            const targetType = isAgent ? 'Agent' : 'Workspace';
            const label = displayLabel || target;
            vscode.window.showInformationMessage(`Focused ${targetType}: ${label}`);
            refreshAllProviders();
            return;
        }

        const safeSession = targetSession ? targetSession.replace(/[^a-zA-Z0-9_-]/g, '') : '';
        const sessionFlag = safeSession && safeSession !== 'default' ? `--session ${safeSession}` : '';
        const command = `herdr ${sessionFlag}`.trim();

        // Create a new Herdr TUI terminal if not found
        const envOverrides: { [key: string]: string | null | undefined } = {
            HERDR_WORKSPACE: null,
            HERDR_PANE_ID: null,
            HERDR_PANE: null,
            HERDR_AGENT: null,
            HERDR_SESSION: null,
            ...(process.env['HERDR_CONFIG_PATH'] ? { HERDR_CONFIG_PATH: process.env['HERDR_CONFIG_PATH'] } : {})
        };

        const terminal = vscode.window.createTerminal({
            name: terminalName,
            env: envOverrides
        });
        terminal.show();
        terminal.sendText(command);

        const targetType = isAgent ? 'Agent' : 'Workspace';
        const label = displayLabel || target || targetSession || 'Herdr';
        vscode.window.showInformationMessage(`Attached to Herdr${sessionLabel} (${targetType}: ${label})`);
        refreshAllProviders();
    }

    // Feature 2: Native Terminal Integration & Target Selectors
    let attachWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.attachWorkspace', async (targetArg?: string, isAgentArg?: boolean, labelArg?: string, sessionArg?: string) => {
        let target = targetArg;
        let isAgent = isAgentArg || false;
        let displayLabel = labelArg || target || '';
        const defaultSession = getActiveSidebarSession();
        let targetSession = sessionArg || defaultSession;
        
        if (!target) {
            const targetItems: TargetQuickPickItem[] = [];

            // 1. Try socket snapshot first for fast rendering
            if (socketClient.isConnected) {
                const snapshot = await socketClient.getSnapshot();
                if (snapshot) {
                    const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                    parsedWorkspaces.forEach(ws => {
                        targetItems.push({
                            label: `[${defaultSession}] $(window) Workspace: ${ws.label}`,
                            description: ws.cwd ? ws.cwd : `ID: ${ws.id}`,
                            targetId: ws.id,
                            sessionName: defaultSession,
                            isAgent: false,
                            displayLabel: ws.label
                        });
                    });

                    const parsedAg = parseSnapshotAgents(snapshot, parsedWorkspaces);
                    parsedAg.forEach(a => {
                        const agentName = a.name && a.name !== a.id ? a.name : 'Agent';
                        const wsName = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
                        const displayLabel = wsName ? `${agentName} [${wsName}]` : agentName;
                        targetItems.push({
                            label: `[${defaultSession}] ${a.statusIcon} Agent: ${agentName}`,
                            description: `${a.status} (ID: ${a.id})`,
                            targetId: a.id,
                            sessionName: defaultSession,
                            isAgent: true,
                            displayLabel: displayLabel
                        });
                    });
                }
            }

            // 2. If no items from socket, query CLI across all sessions
            if (targetItems.length === 0) {
                const sessions = await fetchActiveSessions();
                await Promise.all(sessions.map(sessionName => {
                    return new Promise<void>((resolve) => {
                        const sessionArgs = ['--session', sessionName];
                        let pending = 3;
                        let rawWs = '';
                        let rawPanes = '';
                        let rawAgents = '';

                        const checkDone = () => {
                            pending--;
                            if (pending === 0) {
                                const parsedPanes = parsePanes(rawPanes);
                                const parsedWs = parseWorkspaces(rawWs, parsedPanes, os.homedir());
                                parsedWs.forEach(ws => {
                                    targetItems.push({
                                        label: `[${sessionName}] $(window) Workspace: ${ws.label}`,
                                        description: ws.id,
                                        targetId: ws.id,
                                        sessionName,
                                        isAgent: false,
                                        displayLabel: ws.label
                                    });
                                });

                                const parsedAg = parseAgents(rawAgents, parsedWs);
                                parsedAg.forEach(a => {
                                    const agentName = a.name && a.name !== a.id ? a.name : 'Agent';
                                    const wsName = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
                                    const displayLabel = wsName ? `${agentName} [${wsName}]` : agentName;
                                    targetItems.push({
                                        label: `[${sessionName}] $(hubot) Agent: ${agentName}`,
                                        description: `ID: ${a.id}`,
                                        targetId: a.id,
                                        sessionName,
                                        isAgent: true,
                                        displayLabel: displayLabel
                                    });
                                });

                                resolve();
                            }
                        };

                        execHerdr([...sessionArgs, 'workspace', 'list'], (err: any, out: any) => {
                            if (!err && out) rawWs = out;
                            checkDone();
                        });

                        execHerdr([...sessionArgs, 'pane', 'list'], (err: any, out: any) => {
                            if (!err && out) rawPanes = out;
                            checkDone();
                        });

                        execHerdr([...sessionArgs, 'agent', 'list'], (err: any, out: any) => {
                            if (!err && out) rawAgents = out;
                            checkDone();
                        });
                    });
                }));
            }

            targetItems.push({ 
                label: `$(terminal) Launch Herdr (${defaultSession})`, 
                description: `Attach to ${defaultSession} session`, 
                targetId: 'DEFAULT_HERDR',
                sessionName: defaultSession,
                isAgent: false,
                displayLabel: defaultSession
            });

            const selected = await vscode.window.showQuickPick(targetItems, {
                placeHolder: 'Select Herdr Workspace or Agent to attach (↑/↓ to navigate, Enter to select)',
                title: 'Herdr Collie: Attach Target'
            });

            if (!selected) {
                return;
            }
            target = selected.targetId === 'DEFAULT_HERDR' ? '' : selected.targetId;
            isAgent = selected.isAgent || false;
            targetSession = selected.sessionName || defaultSession;
            displayLabel = selected.displayLabel || target;
        }

        await openOrAttachTerminal(target, isAgent, displayLabel, targetSession);
    });

    let selectAgentDisposable = vscode.commands.registerCommand('herdr-collie.selectAgent', async () => {
        const sessionName = getActiveSidebarSession();
        let agentItems: TargetQuickPickItem[] = [];

        // 1. Try socket snapshot
        if (socketClient.isConnected) {
            const snapshot = await socketClient.getSnapshot();
            if (snapshot) {
                const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                const parsedAgents = parseSnapshotAgents(snapshot, parsedWorkspaces);
                const worktrees = await getWorktreesForCwds(parsedAgents.map(a => a.workspaceCwd));

                agentItems = parsedAgents.map(a => {
                    const displayInfo = formatAgentDisplay(a, worktrees);
                    return {
                        label: displayInfo.label,
                        description: displayInfo.description,
                        detail: a.workspaceCwd ? `Path: ${a.workspaceCwd}` : undefined,
                        targetId: a.id,
                        sessionName,
                        isAgent: true,
                        displayLabel: displayInfo.displayLabel
                    };
                });
            }
        }

        // 2. CLI fallback
        if (agentItems.length === 0 && !socketClient.isConnected) {
            const sessions = await fetchActiveSessions();
            await Promise.all(sessions.map(s => {
                return new Promise<void>((resolve) => {
                    const sessionArgs = ['--session', s];
                    let rawWs = '';
                    let rawPanes = '';
                    let rawAgents = '';
                    let pending = 2;
                    const checkDone = async () => {
                        pending--;
                        if (pending === 0) {
                            const parsedPanes = parsePanes(rawPanes);
                            const parsedWs = parseWorkspaces(rawWs, parsedPanes, os.homedir());
                            const parsedAg = parseAgents(rawAgents, parsedWs);
                            const worktrees = await getWorktreesForCwds(parsedAg.map(a => a.workspaceCwd));
                            parsedAg.forEach(a => {
                                const displayInfo = formatAgentDisplay(a, worktrees);
                                agentItems.push({
                                    label: `[${s}] ${displayInfo.label}`,
                                    description: displayInfo.description,
                                    detail: a.workspaceCwd ? `Path: ${a.workspaceCwd}` : undefined,
                                    targetId: a.id,
                                    sessionName: s,
                                    isAgent: true,
                                    displayLabel: displayInfo.displayLabel
                                });
                            });
                            resolve();
                        }
                    };
                    execHerdr([...sessionArgs, 'pane', 'list'], (err: any, out: any) => {
                        if (!err && out) rawPanes = out;
                        execHerdr([...sessionArgs, 'workspace', 'list'], (wErr: any, wOut: any) => {
                            if (!wErr && wOut) rawWs = wOut;
                            checkDone();
                        });
                    });
                    execHerdr([...sessionArgs, 'agent', 'list'], (err: any, out: any) => {
                        if (!err && out) rawAgents = out;
                        checkDone();
                    });
                });
            }));
        }

        if (agentItems.length === 0) {
            const launchNew = 'Launch Worktree Agent';
            const res = await vscode.window.showInformationMessage('No active Herdr agents found.', launchNew);
            if (res === launchNew) {
                vscode.commands.executeCommand('herdr-collie.launchWorktreeAgent');
            }
            return;
        }

        const selected = await vscode.window.showQuickPick(agentItems, {
            placeHolder: 'Select an agent to open terminal (↑/↓ to navigate, Enter to select)',
            title: 'Herdr Collie: Select & Attach Agent'
        });

        if (!selected) return;
        await openOrAttachTerminal(selected.targetId, true, selected.displayLabel || selected.targetId, selected.sessionName || sessionName);
    });

    let selectWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.selectWorkspace', async () => {
        const sessionName = getActiveSidebarSession();
        let wsItems: TargetQuickPickItem[] = [];

        // 1. Try socket snapshot
        if (socketClient.isConnected) {
            const snapshot = await socketClient.getSnapshot();
            if (snapshot) {
                const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                const parsedAgents = parseSnapshotAgents(snapshot, parsedWorkspaces);
                const worktrees = await getWorktreesForCwds(parsedWorkspaces.map(w => w.cwd));
                const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

                wsItems = parsedWorkspaces.map(ws => {
                    const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAgents, currentRoot);
                    const icon = `$(${displayInfo.iconId})`;

                    return {
                        label: `${icon} ${displayInfo.label}`,
                        description: displayInfo.description,
                        detail: displayInfo.isWorktree 
                            ? `Git Worktree at ${ws.cwd}${displayInfo.agentBadges ? ` • Agents: ${displayInfo.agentBadges}` : ''}`
                            : (displayInfo.agentBadges ? `Active Agents: ${displayInfo.agentBadges}` : (ws.cwd ? `Path: ${ws.cwd}` : undefined)),
                        targetId: ws.id,
                        sessionName,
                        isAgent: false,
                        displayLabel: ws.label
                    };
                });
            }
        }

        // 2. CLI fallback
        if (wsItems.length === 0 && !socketClient.isConnected) {
            const sessions = await fetchActiveSessions();
            await Promise.all(sessions.map(s => {
                return new Promise<void>((resolve) => {
                    const sessionArgs = ['--session', s];
                    let pending = 2;
                    let rawWs = '';
                    let rawPanes = '';
                    const checkDone = () => {
                        pending--;
                        if (pending === 0) {
                            const parsedPanes = parsePanes(rawPanes);
                            const parsedWs = parseWorkspaces(rawWs, parsedPanes, os.homedir());
                            parsedWs.forEach(ws => {
                                wsItems.push({
                                    label: `[${s}] $(window) Workspace: ${ws.label}`,
                                    description: ws.cwd || `ID: ${ws.id}`,
                                    targetId: ws.id,
                                    sessionName: s,
                                    isAgent: false,
                                    displayLabel: ws.label
                                });
                            });
                            resolve();
                        }
                    };
                    execHerdr([...sessionArgs, 'workspace', 'list'], (err: any, out: any) => {
                        if (!err && out) rawWs = out;
                        checkDone();
                    });
                    execHerdr([...sessionArgs, 'pane', 'list'], (err: any, out: any) => {
                        if (!err && out) rawPanes = out;
                        checkDone();
                    });
                });
            }));
        }

        if (wsItems.length === 0) {
            const createNew = 'Create Workspace';
            const res = await vscode.window.showInformationMessage('No Herdr workspaces found.', createNew);
            if (res === createNew) {
                vscode.commands.executeCommand('herdr-collie.createWorkspace');
            }
            return;
        }

        const selected = await vscode.window.showQuickPick(wsItems, {
            placeHolder: 'Select a workspace to focus (↑/↓ to navigate, Enter to select)',
            title: 'Herdr Collie: Select & Focus Workspace'
        });

        if (!selected) return;
        await openOrAttachTerminal(selected.targetId, false, selected.displayLabel || selected.targetId, selected.sessionName || sessionName);
    });

    context.subscriptions.push(attachWorkspaceDisposable, selectAgentDisposable, selectWorkspaceDisposable);



    // Feature 1: Context Injection
    
    async function sendToHerdr(richText: string, successMsg: string, quickPickTitle: string) {
        const defaultSession = getSessionName();
        const sessions = await fetchActiveSessions();
        const currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        const allItems: TargetQuickPickItem[] = [];
        const primaryItems: TargetQuickPickItem[] = [];
        const otherItems: TargetQuickPickItem[] = [];

        await Promise.all(sessions.map(sessionName => {
            return new Promise<void>((resolve) => {
                const sessionArgs = ['--session', sessionName];
                let pending = 2;
                const checkDone = () => {
                    pending--;
                    if (pending === 0) resolve();
                };

                execHerdr([...sessionArgs, 'pane', 'list'], (error: any, stdout: any) => {
                    if (!error && stdout) {
                        const panes = parsePanes(stdout);
                        panes.forEach(p => {
                            const isCurrentSession = sessionName === defaultSession;
                            const isCurrentCwd = Boolean(currentCwd && (p.cwd === currentCwd || p.cwd.startsWith(currentCwd)));
                            const item: TargetQuickPickItem = {
                                label: `[${sessionName}] $(terminal) Pane: ${p.name || p.id}`,
                                description: `Session: ${sessionName}${p.command ? ` | ${p.command}` : ''}${isCurrentCwd ? ' (Current Project)' : ''}`,
                                targetId: p.id,
                                sessionName,
                                isAgent: false
                            };
                            allItems.push(item);
                            
                            // For primary list: prioritize panes in the current session associated with this project
                            if (isCurrentSession && isCurrentCwd) {
                                primaryItems.push(item);
                            } else {
                                otherItems.push(item);
                            }
                        });
                    }
                    checkDone();
                });

                execHerdr([...sessionArgs, 'agent', 'list'], (error: any, stdout: any) => {
                    if (!error && stdout) {
                        const agents = parseAgents(stdout);
                        agents.forEach(a => {
                            const isCurrentSession = sessionName === defaultSession;
                            const item: TargetQuickPickItem = {
                                label: `[${sessionName}] $(hubot) Agent: ${a.name || a.id}`,
                                description: `Session: ${sessionName} | Status: ${a.status}`,
                                targetId: a.id,
                                sessionName,
                                isAgent: true
                            };
                            allItems.push(item);
                            
                            // Agents in the current session are high priority
                            if (isCurrentSession) {
                                primaryItems.push(item);
                            } else {
                                otherItems.push(item);
                            }
                        });
                    }
                    checkDone();
                });
            });
        }));

        // Sort items: Agents first, then Panes
        primaryItems.sort((a, b) => (b.isAgent ? 1 : 0) - (a.isAgent ? 1 : 0));
        allItems.sort((a, b) => (b.isAgent ? 1 : 0) - (a.isAgent ? 1 : 0));

        let displayItems: TargetQuickPickItem[] = [];
        const hasOtherOptions = otherItems.length > 0;

        if (primaryItems.length > 0 && hasOtherOptions) {
            displayItems = [
                ...primaryItems,
                {
                    label: '$(ellipsis) その他の送信先を選択... (Other sessions / panes)',
                    description: `Browse ${otherItems.length} more target(s) across sessions`,
                    targetId: '__SHOW_ALL__',
                    isAgent: false
                }
            ];
        } else if (primaryItems.length > 0) {
            displayItems = primaryItems;
        } else if (allItems.length > 0) {
            displayItems = allItems;
        } else {
            displayItems = [{
                label: '(No targets found)',
                description: 'Run herdr in a terminal first',
                targetId: ''
            }];
        }

        let selected = await vscode.window.showQuickPick(displayItems, {
            placeHolder: 'Select target Herdr agent or terminal',
            title: quickPickTitle
        });

        if (!selected || !selected.targetId) return;

        // If user chose "Other...", show full list across all sessions and panes
        if (selected.targetId === '__SHOW_ALL__') {
            selected = await vscode.window.showQuickPick(allItems, {
                placeHolder: 'Select target across all sessions and panes',
                title: `${quickPickTitle} (All Targets)`
            });
            if (!selected || !selected.targetId) return;
        }
        
        const target = selected.targetId;
        const sessionName = selected.sessionName;
        const sessionArgs = sessionName ? ['--session', sessionName] : [];
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!selected.isAgent) {
            execHerdr([...sessionArgs, 'pane', 'send-text', target, richText], { cwd }, (error: any) => {
                if (error) {
                    vscode.window.showErrorMessage('Failed to send: ' + error.message);
                    return;
                }
                const prefix = sessionName ? `[${sessionName}] ` : '';
                vscode.window.showInformationMessage(`${successMsg} (${prefix}Pane)`);
            });
            return;
        }
        
        execHerdr([...sessionArgs, 'agent', 'prompt', target, richText], { cwd }, (error: any) => {
            if (error) {
                if (error.message && error.message.includes('agent_not_found')) {
                    execHerdr([...sessionArgs, 'pane', 'send-text', target, richText], { cwd }, (fbError: any) => {
                        if (fbError) {
                            vscode.window.showErrorMessage('Failed to send: ' + fbError.message);
                            return;
                        }
                        const prefix = sessionName ? `[${sessionName}] ` : '';
                        vscode.window.showInformationMessage(`${successMsg} (${prefix}Pane)`);
                    });
                    return;
                }
                vscode.window.showErrorMessage('Failed to send context: ' + error.message);
                return;
            }
            vscode.window.showInformationMessage(successMsg + ' (Agent)');
        });
    }

    let sendContextDisposable = vscode.commands.registerCommand('herdr-collie.sendContext', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.selection;
        const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
        if (!text.trim()) return;
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const richText = formatSelectionContext(fileName, startLine, endLine, editor.document.languageId, text);
        await sendToHerdr(richText, 'Context sent successfully', 'Send Selection to Herdr');
    });

    let sendDiagnosticsDisposable = vscode.commands.registerCommand('herdr-collie.sendDiagnostics', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        if (diagnostics.length === 0) {
            vscode.window.showInformationMessage('No errors or warnings found.');
            return;
        }
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const richText = formatFileDiagnostics(
            fileName, 
            diagnostics.map(d => ({ line: d.range.start.line + 1, message: d.message }))
        );
        await sendToHerdr(richText, 'Diagnostics sent successfully', 'Send Diagnostics to Herdr');
    });

    let sendStagedChangesDisposable = vscode.commands.registerCommand('herdr-collie.sendStagedChanges', async (...args) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const cwd = workspaceFolders[0].uri.fsPath;
        
        let targetFile = '';
        if (args.length > 0 && args[0] && args[0].resourceUri) {
            targetFile = vscode.workspace.asRelativePath(args[0].resourceUri as vscode.Uri);
        }

        try {
            const gitArgs = targetFile ? ['diff', '--cached', '--', targetFile] : ['diff', '--cached'];
            const stdout = await runGitCmd(gitArgs, cwd);
            if (!stdout.trim()) {
                vscode.window.showInformationMessage(`No staged changes found${targetFile ? ' for this file' : ''}.`);
                return;
            }
            const richText = formatGitDiff(stdout, targetFile, true);
            await sendToHerdr(richText, 'Staged Changes sent successfully', 'Send Staged Changes to Herdr');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to get staged changes: ${e.message}`);
        }
    });

    let sendWorkingTreeChangesDisposable = vscode.commands.registerCommand('herdr-collie.sendWorkingTreeChanges', async (...args) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const cwd = workspaceFolders[0].uri.fsPath;
        
        let targetFile = '';
        if (args.length > 0 && args[0] && args[0].resourceUri) {
            targetFile = vscode.workspace.asRelativePath(args[0].resourceUri as vscode.Uri);
        }

        try {
            const gitArgs = targetFile ? ['diff', '--', targetFile] : ['diff'];
            const stdout = await runGitCmd(gitArgs, cwd);
            if (!stdout.trim()) {
                vscode.window.showInformationMessage(`No working tree changes found${targetFile ? ' for this file' : ''}.`);
                return;
            }
            const richText = formatGitDiff(stdout, targetFile, false);
            await sendToHerdr(richText, 'Working Tree Changes sent successfully', 'Send Working Tree Changes to Herdr');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to get working tree changes: ${e.message}`);
        }
    });

    let sendBranchContextDisposable = vscode.commands.registerCommand('herdr-collie.sendBranchContext', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const cwd = workspaceFolders[0].uri.fsPath;

        try {
            const branchOut = await runGitCmd(['branch', '--show-current'], cwd);
            const currentBranch = branchOut.trim() || 'HEAD detached';
            
            // Try to find the base branch (defaulting to main or master)
            let logArgs = ['log', '-n', '15', '--oneline'];
            try {
                // Determine if we diverged from main or master
                const hasMain = (await runGitCmd(['rev-parse', '--verify', 'main'], cwd).catch(() => '')).trim() !== '';
                const baseBranch = hasMain ? 'main' : 'master';
                // Only show commits unique to this branch if possible
                logArgs = ['log', `${baseBranch}..HEAD`, '--oneline'];
            } catch (e) {
                // Ignore fallback to recent 15 commits
            }

            let logOut = await runGitCmd(logArgs, cwd);
            if (!logOut.trim()) {
                // Fallback again if empty
                logOut = await runGitCmd(['log', '-n', '15', '--oneline'], cwd);
            }
            
            const richText = formatBranchContext(currentBranch, logOut);
            await sendToHerdr(richText, 'Branch Context sent successfully', 'Send Branch Context to Herdr');

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to get branch context: ${e.message}`);
        }
    });

    let sendWorkspaceProblemsDisposable = vscode.commands.registerCommand('herdr-collie.sendWorkspaceProblems', async () => {
        const diagnostics = vscode.languages.getDiagnostics();
        const problemsByFile: { [file: string]: { line: number; severity: 'Error' | 'Warning'; message: string }[] } = {};
        
        for (const [uri, fileDiagnostics] of diagnostics) {
            if (fileDiagnostics.length === 0) continue;
            
            const issues = fileDiagnostics.filter(d => 
                d.severity === vscode.DiagnosticSeverity.Error || 
                d.severity === vscode.DiagnosticSeverity.Warning
            );
            
            if (issues.length === 0) continue;

            const relativePath = vscode.workspace.asRelativePath(uri);
            problemsByFile[relativePath] = issues.map(d => ({
                line: d.range.start.line + 1,
                severity: (d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning') as 'Error' | 'Warning',
                message: d.message
            }));
        }

        const richText = formatWorkspaceProblems(problemsByFile);
        if (!richText) {
            vscode.window.showInformationMessage('No workspace problems (Errors/Warnings) found.');
            return;
        }

        await sendToHerdr(richText, 'Workspace Problems sent successfully', 'Send Workspace Problems to Herdr');
    });

    let sendHoverInfoDisposable = vscode.commands.registerCommand('herdr-collie.sendHoverInfo', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Please place your cursor on a symbol in the editor.');
            return;
        }

        const position = editor.selection.active;
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, position);
        
        if (!hovers || hovers.length === 0) {
            vscode.window.showInformationMessage('No hover information available for this symbol.');
            return;
        }

        let hoverContents: string[] = [];
        for (const hover of hovers) {
            for (const content of hover.contents) {
                if (typeof content === 'string') {
                    hoverContents.push(content);
                } else {
                    hoverContents.push(content.value);
                }
            }
        }

        const wordRange = editor.document.getWordRangeAtPosition(position);
        const symbolName = wordRange ? editor.document.getText(wordRange) : 'the symbol';

        const richText = formatHoverInfo(symbolName, hoverContents);
        await sendToHerdr(richText, 'Symbol Hover Info sent successfully', 'Send Symbol Info to Herdr');
    });

    let sendTerminalOutputDisposable = vscode.commands.registerCommand('herdr-collie.sendTerminalOutput', async (terminalArg?: vscode.Terminal) => {
        const terminal = terminalArg || vscode.window.activeTerminal;
        if (!terminal) {
            vscode.window.showInformationMessage('No active terminal found.');
            return;
        }

        // Save original clipboard text
        let originalClipboard = '';
        try {
            originalClipboard = await vscode.env.clipboard.readText();
        } catch {
            // Ignore clipboard errors
        }

        let outputText = '';

        try {
            // Try to copy current selection in terminal first
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            const selectionText = await vscode.env.clipboard.readText();

            if (selectionText && selectionText !== originalClipboard) {
                outputText = selectionText;
            } else {
                // If no selection, select all buffer, copy, then clear selection
                await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
                await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
                await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
                outputText = await vscode.env.clipboard.readText();
            }
        } catch (e: any) {
            // Fallback or handle error
        } finally {
            // Restore clipboard
            try {
                await vscode.env.clipboard.writeText(originalClipboard);
            } catch {
                // Ignore
            }
        }

        if (!outputText || !outputText.trim()) {
            vscode.window.showInformationMessage('No terminal output or selection found.');
            return;
        }

        // Tail the terminal output to the most recent lines if very long
        const lines = outputText.split('\n');
        const recentText = lines.length > 200 ? lines.slice(-200).join('\n') : outputText;

        const richText = formatTerminalOutput(terminal.name, recentText);
        await sendToHerdr(richText, 'Terminal Output sent successfully', 'Send Terminal Output to Herdr');
    });

    context.subscriptions.push(
        sendContextDisposable,
        sendDiagnosticsDisposable,
        sendStagedChangesDisposable, 
        sendWorkingTreeChangesDisposable, 
        sendBranchContextDisposable, 
        sendWorkspaceProblemsDisposable, 
        sendHoverInfoDisposable, 
        sendTerminalOutputDisposable
    );

// Feature 3: GUI Sidebar Manager (Socket-driven) & Agent/Workspace HUD
    const sessionProvider = new HerdrSessionProvider(getActiveSidebarSession, fetchActiveSessions);
    const workspaceProvider = new HerdrWorkspaceProvider('workspaces', socketClient, getActiveSidebarSession);
    const agentProvider = new HerdrWorkspaceProvider('agents', socketClient, getActiveSidebarSession);
    const agentHUD = new AgentHUD(socketClient, getActiveSidebarSession);
    const workspaceHUD = new WorkspaceHUD(socketClient, getActiveSidebarSession, getWorktreesForCwds);
    const workspaceDragAndDropController = new WorkspaceDragAndDropController(
        () => workspaceProvider.getCurrentItems(),
        () => socketClient,
        () => refreshAllProviders()
    );

    const initialSort = vscode.workspace.getConfiguration('herdr-collie').get<AgentSortOrder>('agentSortOrder', 'grouped') || 'grouped';
    agentProvider.setSortOrder(initialSort);

    context.subscriptions.push(
        sessionProvider,
        workspaceProvider, 
        agentProvider, 
        agentHUD, 
        workspaceHUD,
        { dispose: () => socketClient.dispose() }
    );

    const sessionTreeView = vscode.window.createTreeView('herdr-collie.sessions', {
        treeDataProvider: sessionProvider
    });
    const workspaceTreeView = vscode.window.createTreeView('herdr-collie.workspaces', {
        treeDataProvider: workspaceProvider,
        dragAndDropController: workspaceDragAndDropController
    });
    const agentTreeView = vscode.window.createTreeView('herdr-collie.agents', {
        treeDataProvider: agentProvider
    });
    context.subscriptions.push(sessionTreeView, workspaceTreeView, agentTreeView);

    // Bidirectional selection synchronization between Workspaces and Agents
    let isSyncingSelection = false;

    agentTreeView.onDidChangeSelection(async e => {
        if (isSyncingSelection || !e.selection || e.selection.length === 0) return;
        const selected = e.selection[0] as HerdrWorkspaceTreeItem;
        if (!selected) return;

        const allWs = workspaceProvider.getCurrentItems();
        const selectedWsId = selected.workspaceId;
        const matchingWs = allWs.find(ws => 
            (selectedWsId && (ws.rawId || ws.id) === selectedWsId) ||
            (selected.cwd && ws.cwd && ws.cwd === selected.cwd)
        );

        if (matchingWs) {
            const currentSelected = workspaceTreeView.selection[0] as HerdrWorkspaceTreeItem | undefined;
            if (currentSelected && (currentSelected.rawId || currentSelected.id) === (matchingWs.rawId || matchingWs.id)) {
                return;
            }
            isSyncingSelection = true;
            try {
                await workspaceTreeView.reveal(matchingWs, { select: true, focus: false });
            } catch {
                // Ignore if view is not visible or reveal not supported
            } finally {
                isSyncingSelection = false;
            }
        }
    });

    workspaceTreeView.onDidChangeSelection(async e => {
        if (isSyncingSelection || !e.selection || e.selection.length === 0) return;
        const selected = e.selection[0] as HerdrWorkspaceTreeItem;
        if (!selected) return;

        const allAgents = agentProvider.getCurrentItems();
        const selectedId = selected.rawId || selected.id;
        const matchingAgent = allAgents.find(a => 
            (a.workspaceId && a.workspaceId === selectedId) ||
            (a.cwd && selected.cwd && a.cwd === selected.cwd)
        );

        if (matchingAgent) {
            const currentSelected = agentTreeView.selection[0] as HerdrWorkspaceTreeItem | undefined;
            if (currentSelected && (currentSelected.rawId || currentSelected.id) === (matchingAgent.rawId || matchingAgent.id)) {
                return;
            }
            isSyncingSelection = true;
            try {
                await agentTreeView.reveal(matchingAgent, { select: true, focus: false });
            } catch {
                // Ignore if view is not visible or reveal not supported
            } finally {
                isSyncingSelection = false;
            }
        }
    });

    // Automatically highlight the active workspace and its agent on load / refresh
    const syncActiveSelection = async () => {
        if (isSyncingSelection) return;
        const allWs = workspaceProvider.getCurrentItems();
        if (allWs.length === 0) return;

        const focusedWs = allWs.find(w => w.isFocused) || allWs[0];
        if (focusedWs) {
            const currentSelected = workspaceTreeView.selection[0] as HerdrWorkspaceTreeItem | undefined;
            if (!currentSelected || currentSelected.id !== focusedWs.id) {
                isSyncingSelection = true;
                try {
                    await workspaceTreeView.reveal(focusedWs, { select: true, focus: false });
                } catch {
                } finally {
                    isSyncingSelection = false;
                }
            }
        }

        const allAgents = agentProvider.getCurrentItems();
        if (allAgents.length > 0 && focusedWs) {
            const focusedId = focusedWs.rawId || focusedWs.id;
            const matchingAgent = allAgents.find(a => 
                (a.workspaceId && a.workspaceId === focusedId) ||
                (a.cwd && focusedWs.cwd && a.cwd === focusedWs.cwd)
            );
            if (matchingAgent) {
                const currentAgentSelected = agentTreeView.selection[0] as HerdrWorkspaceTreeItem | undefined;
                if (!currentAgentSelected || currentAgentSelected.id !== matchingAgent.id) {
                    isSyncingSelection = true;
                    try {
                        await agentTreeView.reveal(matchingAgent, { select: true, focus: false });
                    } catch {
                    } finally {
                        isSyncingSelection = false;
                    }
                }
            }
        }
    };

    workspaceProvider.onDidUpdateItems(() => setTimeout(syncActiveSelection, 60));
    agentProvider.onDidUpdateItems(() => setTimeout(syncActiveSelection, 60));

    const updateTreeViewDescriptions = () => {
        workspaceTreeView.description = undefined;
        agentTreeView.description = agentProvider.getSortOrder();
    };
    updateTreeViewDescriptions();

    refreshAllProviders = () => { 
        sessionProvider.refresh();
        workspaceProvider.refresh(); 
        agentProvider.refresh(); 
        agentHUD.refresh();
        workspaceHUD.refresh();
    };

    const setupSocketListeners = (client: HerdrSocketClient) => {
        client.on('connect', () => refreshAllProviders());
        client.on('event', () => refreshAllProviders());
        client.on('disconnect', () => refreshAllProviders());
        client.on('error', () => {});
    };
    setupSocketListeners(socketClient);
    refreshAllProviders();

    // Periodic status polling to guarantee real-time sync across UI tabs
    const statusPollInterval = setInterval(() => {
        if (socketClient && socketClient.isConnected) {
            refreshAllProviders();
        }
    }, 1200);
    context.subscriptions.push({ dispose: () => clearInterval(statusPollInterval) });

    let toggleAgentSortDisposable = vscode.commands.registerCommand('herdr-collie.toggleAgentSort', () => {
        const newOrder = agentProvider.toggleSortOrder();
        updateTreeViewDescriptions();
        const orderLabel = newOrder === 'priority' ? 'Priority (Attention Queue)' : 'Grouped by Workspace';
        vscode.window.setStatusBarMessage(`Agent Sort: ${orderLabel}`, 3000);
    });
    context.subscriptions.push(toggleAgentSortDisposable);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('herdr-collie.sessionName')) {
                const newSession = getSessionName();
                activeSidebarSession = newSession;
                await ensureSessionServerRunning(newSession);
                socketClient.dispose();
                socketClient = new HerdrSocketClient(newSession);
                socketClient.connect();
                setupSocketListeners(socketClient);
                workspaceProvider.updateSocketClient(socketClient);
                agentProvider.updateSocketClient(socketClient);
                agentHUD.updateSocketClient(socketClient);
                workspaceHUD.updateSocketClient(socketClient);
                workspaceDragAndDropController.updateSocketClient(socketClient);
                updateTreeViewDescriptions();
                refreshAllProviders();
            }
            if (e.affectsConfiguration('herdr-collie.agentSortOrder')) {
                const newSort = vscode.workspace.getConfiguration('herdr-collie').get<AgentSortOrder>('agentSortOrder', 'grouped') || 'grouped';
                agentProvider.setSortOrder(newSort);
                updateTreeViewDescriptions();
            }
        })
    );

    interface SessionQuickPickItem extends vscode.QuickPickItem {
        sessionName?: string;
        isCustom?: boolean;
    }

    const switchToSession = async (targetSession: string) => {
        if (!targetSession || targetSession === activeSidebarSession) return;

        activeSidebarSession = targetSession;
        await ensureSessionServerRunning(activeSidebarSession);

        socketClient.dispose();
        socketClient = new HerdrSocketClient(activeSidebarSession);
        socketClient.connect();
        setupSocketListeners(socketClient);

        workspaceProvider.updateSocketClient(socketClient);
        agentProvider.updateSocketClient(socketClient);
        agentHUD.updateSocketClient(socketClient);
        workspaceHUD.updateSocketClient(socketClient);
        workspaceDragAndDropController.updateSocketClient(socketClient);
        updateTreeViewDescriptions();
        refreshAllProviders();

        vscode.window.showInformationMessage(`Herdr Collie view switched to session "${activeSidebarSession}"`);
    };

    const performDeleteSession = async (sessionToDelete: string) => {
        if (!sessionToDelete || sessionToDelete === 'default') {
            vscode.window.showWarningMessage('The "default" session cannot be deleted.');
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to stop and delete Herdr session "${sessionToDelete}"? All workspaces and panes inside it will be terminated.`,
            { modal: true },
            'Delete'
        );

        if (answer !== 'Delete') return;

        execHerdr(['session', 'stop', sessionToDelete], () => {
            execHerdr(['session', 'delete', sessionToDelete], async (err: any) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to delete session: ${err.message}`);
                    return;
                }
                vscode.window.showInformationMessage(`Session "${sessionToDelete}" deleted.`);

                if (activeSidebarSession === sessionToDelete) {
                    const fallbackSession = getSessionName() !== sessionToDelete ? getSessionName() : 'default';
                    await switchToSession(fallbackSession);
                } else {
                    refreshAllProviders();
                }
            });
        });
    };

    let switchSessionDirectDisposable = vscode.commands.registerCommand('herdr-collie.switchSessionDirect', async (targetSession: string) => {
        if (targetSession) {
            await switchToSession(targetSession);
        }
    });

    let createSessionDisposable = vscode.commands.registerCommand('herdr-collie.createSession', async () => {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter new Herdr session name',
            placeHolder: 'e.g. backend, project-x, debug',
            validateInput: validateSessionName
        });
        if (!input || !input.trim()) return;
        await switchToSession(input.trim());
    });

    let refreshSessionsDisposable = vscode.commands.registerCommand('herdr-collie.refreshSessions', () => {
        sessionProvider.refresh();
    });

    let switchSessionDisposable = vscode.commands.registerCommand('herdr-collie.switchSession', async () => {
        const sessions = await fetchActiveSessions();
        const items: SessionQuickPickItem[] = sessions.map(name => ({
            label: name === activeSidebarSession ? `$(check) ${name}` : `$(server) ${name}`,
            description: name === activeSidebarSession ? 'Current session' : '',
            detail: name === 'default' ? 'Herdr default persistent session' : `Herdr session: ${name}`,
            sessionName: name,
            buttons: name !== 'default' ? [{
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: `Stop and delete session "${name}"`
            }] : []
        }));

        items.push({
            label: '$(plus) Switch to custom session...',
            description: 'Enter a custom session name',
            detail: '',
            isCustom: true
        });

        const qp = vscode.window.createQuickPick<SessionQuickPickItem>();
        qp.items = items;
        qp.placeholder = `Current session: ${activeSidebarSession}. Select session to switch sidebar view:`;
        qp.title = 'Switch Herdr Session';

        qp.onDidTriggerItemButton(async (e) => {
            qp.hide();
            if (e.item.sessionName) {
                await performDeleteSession(e.item.sessionName);
            }
        });

        qp.onDidAccept(async () => {
            const selected = qp.selectedItems[0];
            qp.hide();
            if (!selected) return;

            if (selected.isCustom) {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter session name',
                    placeHolder: 'e.g. default, vscode, project-x',
                    validateInput: validateSessionName
                });
                if (!input || !input.trim()) return;
                await switchToSession(input.trim());
            } else if (selected.sessionName) {
                await switchToSession(selected.sessionName);
            }
        });

        qp.onDidHide(() => {
            qp.dispose();
        });

        qp.show();
    });

    let deleteSessionDisposable = vscode.commands.registerCommand('herdr-collie.deleteSession', async (arg?: any) => {
        let sessionToDelete: string | undefined;
        if (typeof arg === 'string') {
            sessionToDelete = arg;
        } else if (arg && typeof arg.sessionName === 'string') {
            sessionToDelete = arg.sessionName;
        }
        if (!sessionToDelete) {
            const sessions = (await fetchActiveSessions()).filter(s => s !== 'default');
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No custom sessions available to delete.');
                return;
            }
            const selected = await vscode.window.showQuickPick(sessions, {
                placeHolder: 'Select a session to stop and delete',
                title: 'Delete Herdr Session'
            });
            if (!selected) return;
            sessionToDelete = selected;
        }

        await performDeleteSession(sessionToDelete);
    });

    // Auto-bind VS Code workspace to Herdr workspace safely without duplicates
    const currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsName = vscode.workspace.name || (currentCwd ? path.basename(currentCwd) : 'VSCode Workspace');
    if (currentCwd) {
        execHerdr(['--session', activeSidebarSession, 'pane', 'list'], (pErr: any, pStdout: any) => {
            const parsedPanes = (!pErr && pStdout) ? parsePanes(pStdout) : [];

            execHerdr(['--session', activeSidebarSession, 'workspace', 'list'], (wErr: any, wStdout: any) => {
                if (!wErr && wStdout) {
                    const parsedWs = parseWorkspaces(wStdout, parsedPanes, os.homedir());
                    const matchedWs = parsedWs.find(w => w.label === wsName || w.id === currentCwd);
                    if (matchedWs) {
                        execHerdr(['--session', activeSidebarSession, 'workspace', 'focus', matchedWs.id], () => refreshAllProviders());
                        return;
                    }
                }

                // If no matching workspace by label/project, create one
                execHerdr(['--session', activeSidebarSession, 'workspace', 'create', '--cwd', currentCwd, '--label', wsName], () => refreshAllProviders());
            });
        });
    }

    let refreshDisposable = vscode.commands.registerCommand('herdr-collie.refreshWorkspaces', () => {
        refreshAllProviders();
    });

    let createWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.createWorkspace', async () => {
        const label = await vscode.window.showInputBox({
            prompt: 'Enter a label for the new workspace (optional)',
            placeHolder: 'My New Workspace'
        });
        
        if (label === undefined) return;
        
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const createArgs = ['--session', activeSidebarSession, 'workspace', 'create', '--cwd', cwd];
        if (label) {
            createArgs.push('--label', label);
        }

        execHerdr(createArgs, (error: any) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to create workspace: ${error.message}`);
                return;
            }
            refreshAllProviders();
        });
    });

    let renameWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.renameWorkspace', async (item: HerdrWorkspaceTreeItem) => {
        if (!item || !item.id) return;
        
        const currentLabel = item.label.replace('★ ', '').replace(/\(\d+ panes\)/, '').trim();
        
        const newLabel = await vscode.window.showInputBox({
            prompt: `Enter new label for workspace ${item.id}`,
            value: currentLabel
        });
        
        if (!newLabel) return;

        execHerdr(['--session', activeSidebarSession, 'workspace', 'rename', item.id, newLabel], (error: any) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to rename workspace: ${error.message}`);
                return;
            }
            refreshAllProviders();
        });
    });

    let closeWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.closeWorkspace', async (item: HerdrWorkspaceTreeItem) => {
        if (!item || !item.id) return;
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to close workspace ${item.id}?`,
            { modal: true },
            'Close'
        );
        
        if (confirm !== 'Close') return;

        execHerdr(['--session', activeSidebarSession, 'workspace', 'close', item.id], (error: any) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to close workspace: ${error.message}`);
                return;
            }
            refreshAllProviders();
        });
    });

    // P1: Smart Swarm & Worktree Commands
    let launchWorktreeAgentDisposable = vscode.commands.registerCommand('herdr-collie.launchWorktreeAgent', async () => {
        await launchWorktreeAgentWizard(getActiveSidebarSession(), () => refreshAllProviders());
    });

    let mergeWorktreeDisposable = vscode.commands.registerCommand('herdr-collie.mergeWorktree', async (item?: HerdrWorkspaceTreeItem) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a workspace folder first.');
            return;
        }
        const repoRoot = await getRepoRoot(workspaceFolders[0].uri.fsPath);
        if (!repoRoot) {
            vscode.window.showErrorMessage('The current workspace is not a Git repository.');
            return;
        }

        let branchToMerge = item?.branchName;
        if (!branchToMerge) {
            const worktrees = await listGitWorktrees(repoRoot);
            const candidates = worktrees.filter(w => w.branch && w.worktree !== repoRoot);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage('No active Git worktree branches found to merge.');
                return;
            }
            const selected = await vscode.window.showQuickPick(candidates.map(c => ({
                label: `$(git-branch) ${c.branch}`,
                description: c.worktree,
                branch: c.branch!
            })), {
                title: 'Merge Worktree Branch into Current Branch',
                placeHolder: 'Select worktree branch to merge'
            });
            if (!selected) return;
            branchToMerge = selected.branch;
        }

        const confirm = await vscode.window.showInformationMessage(
            `Merge branch '${branchToMerge}' into your active branch?`,
            'Merge',
            'Cancel'
        );
        if (confirm !== 'Merge') return;

        try {
            const out = await mergeWorktreeBranch(repoRoot, branchToMerge);
            vscode.window.showInformationMessage(`Merged '${branchToMerge}' successfully.\n${out.trim()}`);
            refreshAllProviders();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Merge failed: ${e.message || e}`);
        }
    });

    let removeWorktreeDisposable = vscode.commands.registerCommand('herdr-collie.removeWorktree', async (item?: HerdrWorkspaceTreeItem) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const repoRoot = await getRepoRoot(workspaceFolders[0].uri.fsPath);
        if (!repoRoot) return;

        let targetPath = item?.cwd;
        let targetId = item?.id;
        let targetLabel = item?.label || 'Worktree';

        if (!targetPath) {
            const worktrees = await listGitWorktrees(repoRoot);
            const candidates = worktrees.filter(w => w.worktree !== repoRoot);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage('No active Git worktrees found to remove.');
                return;
            }
            const selected = await vscode.window.showQuickPick(candidates.map(c => ({
                label: `$(trash) ${c.branch || path.basename(c.worktree)}`,
                description: c.worktree,
                worktree: c.worktree,
                branch: c.branch
            })), {
                title: 'Remove Git Worktree',
                placeHolder: 'Select worktree to delete'
            });
            if (!selected) return;
            targetPath = selected.worktree;
            targetLabel = selected.branch || path.basename(targetPath) || 'Worktree';
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to remove Git worktree '${targetLabel}' at '${targetPath}'?`,
            { modal: true },
            'Remove Worktree'
        );
        if (confirm !== 'Remove Worktree') return;

        try {
            if (targetId) {
                execHerdr(['--session', getActiveSidebarSession(), 'workspace', 'close', targetId], () => {});
            }
            await removeWorktree(repoRoot, targetPath, true);
            vscode.window.showInformationMessage(`Worktree '${targetLabel}' removed.`);
            refreshAllProviders();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to remove worktree: ${e.message || e}`);
        }
    });

    // P2: Agent Attention HUD Command
    let showAgentHUDDisposable = vscode.commands.registerCommand('herdr-collie.showAgentHUD', async () => {
        await agentHUD.showHUDQuickPick();
    });

    context.subscriptions.push(switchSessionDisposable);
    context.subscriptions.push(switchSessionDirectDisposable);
    context.subscriptions.push(createSessionDisposable);
    context.subscriptions.push(refreshSessionsDisposable);
    context.subscriptions.push(deleteSessionDisposable);
    context.subscriptions.push(refreshDisposable);
    context.subscriptions.push(createWorkspaceDisposable);
    context.subscriptions.push(renameWorkspaceDisposable);
    context.subscriptions.push(closeWorkspaceDisposable);
    context.subscriptions.push(launchWorktreeAgentDisposable);
    context.subscriptions.push(mergeWorktreeDisposable);
    context.subscriptions.push(removeWorktreeDisposable);
    context.subscriptions.push(showAgentHUDDisposable);
}


class HerdrSessionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly sessionName: string,
        public readonly isActive: boolean
    ) {
        super(sessionName, vscode.TreeItemCollapsibleState.None);
        this.contextValue = sessionName === 'default' ? 'defaultSession' : 'deletableSession';
        this.description = isActive ? '(active)' : '';
        this.iconPath = new vscode.ThemeIcon(isActive ? 'star-full' : 'symbol-event');
        this.tooltip = isActive ? `Active Herdr Session: ${sessionName}` : `Click to switch to session: ${sessionName}`;
        if (!isActive) {
            this.command = {
                command: 'herdr-collie.switchSessionDirect',
                title: 'Switch Session',
                arguments: [sessionName]
            };
        }
    }
}

class HerdrSessionProvider implements vscode.TreeDataProvider<HerdrSessionTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<HerdrSessionTreeItem | undefined | null | void> = new vscode.EventEmitter<HerdrSessionTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<HerdrSessionTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(
        private readonly getActiveSession: () => string,
        private readonly getSessions: () => Promise<string[]>
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose() {}

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

class HerdrWorkspaceProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private _onDidUpdateItems: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidUpdateItems: vscode.Event<void> = this._onDidUpdateItems.event;
    private sortOrder: AgentSortOrder = 'grouped';
    private currentItems: HerdrWorkspaceTreeItem[] = [];

    constructor(
        private readonly type: 'workspaces' | 'agents',
        private socketClient: HerdrSocketClient,
        private readonly getSessionName: () => string
    ) {}

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

    refresh(): void {
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
            return [];
        }

        const sessionName = this.getSessionName();

        // 1. Try fetching via fast Unix Domain Socket snapshot (Zero process execution)
        try {
            if (this.socketClient.isConnected) {
                const snapshot = await this.socketClient.getSnapshot();
                if (snapshot) {
                    if (this.type === 'workspaces') {
                        const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                        const parsedAgents = parseSnapshotAgents(snapshot, parsedWorkspaces);
                        const worktrees = await getWorktreesForCwds(parsedWorkspaces.map(w => w.cwd));
                        const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

                        if (parsedWorkspaces.length > 0) {
                            const items = parsedWorkspaces.map(ws => {
                                const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAgents, currentRoot);
                                const contextValue = displayInfo.isWorktree ? 'worktreeWorkspace' : 'workspace';
                                const statusSignature = `${displayInfo.agentBadges || 'none'}:${ws.focused ? '1' : '0'}`;
                                
                                const item = new HerdrWorkspaceTreeItem(
                                    displayInfo.label, 
                                    ws.id, 
                                    vscode.TreeItemCollapsibleState.None, 
                                    contextValue,
                                    ws.cwd,
                                    displayInfo.branchName,
                                    displayInfo.isWorktree,
                                    displayInfo.isFocused,
                                    displayInfo.isCurrentWindow,
                                    undefined,
                                    statusSignature
                                );
                                
                                item.description = displayInfo.description;
                                item.tooltip = displayInfo.tooltip;
                                item.iconPath = new vscode.ThemeIcon(displayInfo.iconId);

                                item.command = { 
                                    command: 'herdr-collie.attachWorkspace', 
                                    title: 'Attach', 
                                    arguments: [ws.id, false, ws.label, sessionName] 
                                };
                                return item;
                            });
                            this.currentItems = items;
                            this._onDidUpdateItems.fire();
                            return items;
                        }
                        this.currentItems = [];
                        const emptyItem = new vscode.TreeItem('(No workspaces found)', vscode.TreeItemCollapsibleState.None);
                        emptyItem.iconPath = new vscode.ThemeIcon('info');
                        return [emptyItem];
                    }

                    if (this.type === 'agents') {
                        const parsedWorkspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                        const parsedAgents = parseSnapshotAgents(snapshot, parsedWorkspaces);
                        const sortedAgents = sortAgents(parsedAgents, this.sortOrder);
                        const worktrees = await getWorktreesForCwds(sortedAgents.map(a => a.workspaceCwd));

                        if (sortedAgents.length > 0) {
                            const items = sortedAgents.map(a => {
                                const displayInfo = formatAgentDisplay(a, worktrees);
                                const statusSignature = `${a.status}:${a.statusIcon}:${a.isBlocked ? 'blocked' : 'normal'}`;

                                const item = new HerdrWorkspaceTreeItem(
                                    displayInfo.label, 
                                    a.id, 
                                    vscode.TreeItemCollapsibleState.None, 
                                    a.isBlocked ? 'blockedAgent' : 'agent',
                                    a.workspaceCwd,
                                    displayInfo.branchName,
                                    false,
                                    false,
                                    false,
                                    a.workspaceId,
                                    statusSignature
                                );
                                item.description = displayInfo.description;
                                item.tooltip = displayInfo.tooltip;
                                item.iconPath = new vscode.ThemeIcon(a.isBlocked ? 'alert' : 'hubot');
                                item.command = { 
                                    command: 'herdr-collie.attachWorkspace', 
                                    title: 'Attach', 
                                    arguments: [a.id, true, displayInfo.displayLabel, sessionName] 
                                };
                                return item;
                            });
                            this.currentItems = items;
                            this._onDidUpdateItems.fire();
                            return items;
                        }
                        this.currentItems = [];
                        const emptyItem = new vscode.TreeItem('(No agents running)', vscode.TreeItemCollapsibleState.None);
                        emptyItem.iconPath = new vscode.ThemeIcon('info');
                        return [emptyItem];
                    }
                }
            }
        } catch (err) {
            console.error(`[herdr-collie] Error loading ${this.type} from socket snapshot:`, err);
        }

        // 2. CLI Fallback if socket is not connected
        return new Promise((resolve) => {
            const sessionArgs = ['--session', sessionName];

            if (this.type === 'workspaces') {
                let rawWorkspaces = '';
                let rawPanes = '';
                let rawAgents = '';
                let pending = 3;

                const checkDone = async () => {
                    pending--;
                    if (pending === 0) {
                        const parsedPanes = parsePanes(rawPanes);
                        const parsedWorkspaces = parseWorkspaces(rawWorkspaces, parsedPanes, os.homedir());
                        const parsedAgents = parseAgents(rawAgents, parsedWorkspaces);
                        const worktrees = await getWorktreesForCwds(parsedWorkspaces.map(w => w.cwd));
                        const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        let items: vscode.TreeItem[] = [];

                        parsedWorkspaces.forEach(ws => {
                            const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAgents, currentRoot);
                            const contextValue = displayInfo.isWorktree ? 'worktreeWorkspace' : 'workspace';
                            const statusSignature = `${displayInfo.agentBadges || 'none'}:${ws.focused ? '1' : '0'}`;

                            const item = new HerdrWorkspaceTreeItem(
                                displayInfo.label, 
                                ws.id, 
                                vscode.TreeItemCollapsibleState.None, 
                                contextValue,
                                ws.cwd,
                                displayInfo.branchName,
                                displayInfo.isWorktree,
                                displayInfo.isFocused,
                                displayInfo.isCurrentWindow,
                                undefined,
                                statusSignature
                            );
                            item.description = displayInfo.description;
                            item.tooltip = displayInfo.tooltip;
                            item.iconPath = new vscode.ThemeIcon(displayInfo.iconId);

                            item.command = { 
                                command: 'herdr-collie.attachWorkspace', 
                                title: 'Attach', 
                                arguments: [ws.id, false, ws.label, sessionName] 
                            };
                            items.push(item);
                        });
                        
                        this.currentItems = items.filter(i => i instanceof HerdrWorkspaceTreeItem) as HerdrWorkspaceTreeItem[];
                        this._onDidUpdateItems.fire();
                        if (items.length === 0) {
                            const emptyItem = new vscode.TreeItem('(No workspaces found)', vscode.TreeItemCollapsibleState.None);
                            emptyItem.iconPath = new vscode.ThemeIcon('info');
                            items.push(emptyItem);
                        }
                        resolve(items);
                    }
                };

                execHerdr([...sessionArgs, 'workspace', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) {
                        rawWorkspaces = stdout;
                    }
                    checkDone();
                });

                execHerdr([...sessionArgs, 'pane', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) {
                        rawPanes = stdout;
                    }
                    checkDone();
                });

                execHerdr([...sessionArgs, 'agent', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) {
                        rawAgents = stdout;
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
                        const parsedAgents = parseAgents(rawAgents, parsedWorkspaces);
                        const sortedAgents = sortAgents(parsedAgents, this.sortOrder);
                        const worktrees = await getWorktreesForCwds(sortedAgents.map(a => a.workspaceCwd));

                        let items: vscode.TreeItem[] = [];
                        sortedAgents.forEach(a => {
                            const displayInfo = formatAgentDisplay(a, worktrees);
                            const statusSignature = `${a.status}:${a.statusIcon}:${a.isBlocked ? 'blocked' : 'normal'}`;

                            const item = new HerdrWorkspaceTreeItem(
                                displayInfo.label, 
                                a.id, 
                                vscode.TreeItemCollapsibleState.None, 
                                a.isBlocked ? 'blockedAgent' : 'agent',
                                a.workspaceCwd,
                                displayInfo.branchName,
                                false,
                                false,
                                false,
                                a.workspaceId,
                                statusSignature
                            );
                            item.description = displayInfo.description;
                            item.tooltip = displayInfo.tooltip;
                            item.iconPath = new vscode.ThemeIcon(a.isBlocked ? 'alert' : 'hubot');
                            item.command = { 
                                command: 'herdr-collie.attachWorkspace', 
                                title: 'Attach', 
                                arguments: [a.id, true, displayInfo.displayLabel, sessionName] 
                            };
                            items.push(item);
                        });

                        this.currentItems = items.filter(i => i instanceof HerdrWorkspaceTreeItem) as HerdrWorkspaceTreeItem[];
                        this._onDidUpdateItems.fire();
                        if (items.length === 0) {
                            const emptyItem = new vscode.TreeItem('(No agents running)', vscode.TreeItemCollapsibleState.None);
                            emptyItem.iconPath = new vscode.ThemeIcon('info');
                            items.push(emptyItem);
                        }
                        resolve(items);
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

                execHerdr([...sessionArgs, 'agent', 'list'], (err: any, stdout: any) => {
                    if (!err && stdout) rawAgents = stdout;
                    checkDone();
                });
                return;
            }
        });
    }
}

export function deactivate() {}
