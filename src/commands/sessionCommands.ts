/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as os from 'os';
import * as path from 'path';
import { execHerdr } from '../executors';
import { formatAgentDisplay, formatWorkspaceDisplay } from '../formatters';
import {
    parseWorkspaces,
    parseAgents,
    parsePanes,
    parseSnapshotWorkspaces,
    parseSnapshotAgents
} from '../parsers';
import { validateSessionName } from '../socketClient';
import { listGitWorktrees, getRepoRoot, openWorkspaceFolderInWindow } from '../worktreeManager';
import { HerdrWorkspaceTreeItem, HerdrTabTreeItem } from '../workspaceDragAndDrop';
import { ensureWorkspaceTrustedForAction } from '../workspaceTrust';
import { getWorktreesForCwds } from '../gitContext';
import { fetchActiveSessions, TargetQuickPickItem, SessionQuickPickItem } from '../herdrBridge';
import { CommandContext } from './types';

export function registerSessionCommands(context: vscode.ExtensionContext, ctx: CommandContext): void {
    let agentOutputChannel: vscode.OutputChannel | null = null;

    const attachWorkspaceDisposable = vscode.commands.registerCommand(
        'herdr-collie.attachWorkspace',
        async (targetArg?: string, isAgentArg?: boolean, labelArg?: string, sessionArg?: string, workspaceIdArg?: string) => {
            if (!(await ensureWorkspaceTrustedForAction(vscode))) return;

            let target = targetArg;
            let isAgent = isAgentArg || false;
            let displayLabel = labelArg || target || '';
            const defaultSession = ctx.getActiveSidebarSession();
            let targetSession = sessionArg || defaultSession;
            let targetWorkspaceId = workspaceIdArg;
            const socketClient = ctx.getSocketClient();

            if (!target) {
                const targetItems: TargetQuickPickItem[] = [];

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
                                displayLabel: ws.label,
                                workspaceId: ws.id
                            });
                        });

                        const parsedAg = parseSnapshotAgents(snapshot, parsedWorkspaces);
                        parsedAg.forEach(a => {
                            const agentName = a.name && a.name !== a.id ? a.name : 'Agent';
                            const wsName = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
                            const itemLabel = wsName ? `${agentName} [${wsName}]` : agentName;
                            targetItems.push({
                                label: `[${defaultSession}] ${a.statusIcon} Agent: ${agentName}`,
                                description: `${a.status} (ID: ${a.id})`,
                                targetId: a.id,
                                sessionName: defaultSession,
                                isAgent: true,
                                displayLabel: itemLabel,
                                workspaceId: a.workspaceId
                            });
                        });
                    }
                }

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
                                            displayLabel: ws.label,
                                            workspaceId: ws.id
                                        });
                                    });

                                    const parsedAg = parseAgents(rawAgents, parsedWs);
                                    parsedAg.forEach(a => {
                                        const agentName = a.name && a.name !== a.id ? a.name : 'Agent';
                                        const wsName = a.workspaceLabel || (a.workspaceId ? `Workspace ${a.workspaceId}` : '');
                                        const itemLabel = wsName ? `${agentName} [${wsName}]` : agentName;
                                        targetItems.push({
                                            label: `[${sessionName}] $(hubot) Agent: ${agentName}`,
                                            description: `ID: ${a.id}`,
                                            targetId: a.id,
                                            sessionName,
                                            isAgent: true,
                                            displayLabel: itemLabel,
                                            workspaceId: a.workspaceId
                                        });
                                    });

                                    resolve();
                                }
                            };

                            execHerdr([...sessionArgs, 'workspace', 'list'], (err, out) => {
                                if (!err && out) rawWs = out;
                                checkDone();
                            });

                            execHerdr([...sessionArgs, 'pane', 'list'], (err, out) => {
                                if (!err && out) rawPanes = out;
                                checkDone();
                            });

                            execHerdr([...sessionArgs, 'agent', 'list'], (err, out) => {
                                if (!err && out) rawAgents = out;
                                checkDone();
                            });
                        });
                    }));
                }

                targetItems.push({
                    label: `$(terminal) ${l10n.t('Launch Herdr ({0})', defaultSession)}`,
                    description: l10n.t('Attach to {0} session', defaultSession),
                    targetId: 'DEFAULT_HERDR',
                    sessionName: defaultSession,
                    isAgent: false,
                    displayLabel: defaultSession
                });

                const selected = await vscode.window.showQuickPick(targetItems, {
                    placeHolder: l10n.t('Select Herdr Agent or Workspace to Attach / Focus'),
                    title: l10n.t('Select Herdr Agent or Workspace to Attach / Focus')
                });

                if (!selected) return;
                target = selected.targetId === 'DEFAULT_HERDR' ? '' : selected.targetId;
                isAgent = selected.isAgent || false;
                targetSession = selected.sessionName || defaultSession;
                displayLabel = selected.displayLabel || target;
                targetWorkspaceId = selected.workspaceId;
            }

            await ctx.openOrAttachTerminal(target, isAgent, displayLabel, targetSession, targetWorkspaceId);
        }
    );

    const selectAgentDisposable = vscode.commands.registerCommand('herdr-collie.selectAgent', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const sessionName = ctx.getActiveSidebarSession();
        const socketClient = ctx.getSocketClient();
        let agentItems: TargetQuickPickItem[] = [];

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
                        detail: a.workspaceCwd ? l10n.t('Path: {0}', a.workspaceCwd) : undefined,
                        targetId: a.id,
                        sessionName,
                        isAgent: true,
                        displayLabel: displayInfo.displayLabel,
                        workspaceId: a.workspaceId
                    };
                });
            }
        }

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
                                    detail: a.workspaceCwd ? l10n.t('Path: {0}', a.workspaceCwd) : undefined,
                                    targetId: a.id,
                                    sessionName: s,
                                    isAgent: true,
                                    displayLabel: displayInfo.displayLabel,
                                    workspaceId: a.workspaceId
                                });
                            });
                            resolve();
                        }
                    };
                    execHerdr([...sessionArgs, 'pane', 'list'], (err, out) => {
                        if (!err && out) rawPanes = out;
                        execHerdr([...sessionArgs, 'workspace', 'list'], (wErr, wOut) => {
                            if (!wErr && wOut) rawWs = wOut;
                            checkDone();
                        });
                    });
                    execHerdr([...sessionArgs, 'agent', 'list'], (err, out) => {
                        if (!err && out) rawAgents = out;
                        checkDone();
                    });
                });
            }));
        }

        if (agentItems.length === 0) {
            const launchNew = l10n.t('Launch New Agent...');
            const res = await vscode.window.showInformationMessage(l10n.t('No active Herdr agents found.'), launchNew);
            if (res === launchNew) {
                vscode.commands.executeCommand('herdr-collie.launchWorktreeAgent');
            }
            return;
        }

        const selected = await vscode.window.showQuickPick(agentItems, {
            placeHolder: l10n.t('Select Herdr Agent to Attach / Focus'),
            title: l10n.t('Select Herdr Agent to Attach / Focus')
        });

        if (!selected) return;
        await ctx.openOrAttachTerminal(
            selected.targetId,
            true,
            selected.displayLabel || selected.targetId,
            selected.sessionName || sessionName,
            selected.workspaceId
        );
    });

    const selectWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.selectWorkspace', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const sessionName = ctx.getActiveSidebarSession();
        const socketClient = ctx.getSocketClient();
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let wsItems: TargetQuickPickItem[] = [];

        if (socketClient.isConnected) {
            const snapshot = await socketClient.getSnapshot();
            if (snapshot) {
                const parsedWs = parseSnapshotWorkspaces(snapshot, os.homedir());
                const parsedAg = parseSnapshotAgents(snapshot, parsedWs);
                const worktrees = await getWorktreesForCwds(parsedWs.map(w => w.cwd));
                wsItems = parsedWs.map(ws => {
                    const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAg, currentFolder);
                    return {
                        label: `$(${displayInfo.iconId}) ${displayInfo.label}`,
                        description: displayInfo.description,
                        detail: displayInfo.tooltip.split('\n')[0],
                        targetId: ws.id,
                        sessionName,
                        displayLabel: ws.label
                    };
                });
            }
        }

        if (wsItems.length === 0 && !socketClient.isConnected) {
            const sessions = await fetchActiveSessions();
            await Promise.all(sessions.map(sName => {
                return new Promise<void>((resolve) => {
                    const sessionArgs = ['--session', sName];
                    let pending = 2;
                    let rawWs = '';
                    let rawPanes = '';
                    const checkDone = async () => {
                        pending--;
                        if (pending === 0) {
                            const parsedPanes = parsePanes(rawPanes);
                            const parsedWs = parseWorkspaces(rawWs, parsedPanes, os.homedir());
                            const worktrees = await getWorktreesForCwds(parsedWs.map(w => w.cwd));
                            parsedWs.forEach(ws => {
                                const displayInfo = formatWorkspaceDisplay(ws, worktrees, [], currentFolder);
                                wsItems.push({
                                    label: `[${sName}] $(${displayInfo.iconId}) ${displayInfo.label}`,
                                    description: displayInfo.description,
                                    detail: displayInfo.tooltip.split('\n')[0],
                                    targetId: ws.id,
                                    sessionName: sName,
                                    displayLabel: ws.label
                                });
                            });
                            resolve();
                        }
                    };
                    execHerdr([...sessionArgs, 'workspace', 'list'], (err, out) => {
                        if (!err && out) rawWs = out;
                        checkDone();
                    });
                    execHerdr([...sessionArgs, 'pane', 'list'], (err, out) => {
                        if (!err && out) rawPanes = out;
                        checkDone();
                    });
                });
            }));
        }

        if (wsItems.length === 0) {
            const createNew = l10n.t('Create New Workspace...');
            const res = await vscode.window.showInformationMessage(l10n.t('No Herdr workspaces found.'), createNew);
            if (res === createNew) {
                vscode.commands.executeCommand('herdr-collie.createWorkspace');
            }
            return;
        }

        const selected = await vscode.window.showQuickPick(wsItems, {
            placeHolder: l10n.t('Select Herdr Workspace to Focus'),
            title: l10n.t('Select Herdr Workspace to Focus')
        });

        if (!selected) return;
        await ctx.openOrAttachTerminal(selected.targetId, false, selected.displayLabel || selected.targetId, selected.sessionName || sessionName);
    });

    const toggleAgentSortDisposable = vscode.commands.registerCommand('herdr-collie.toggleAgentSort', () => {
        const newOrder = ctx.agentProvider.toggleSortOrder();
        ctx.updateTreeViewDescriptions();
        const orderLabel = newOrder === 'priority' ? l10n.t('Priority') : l10n.t('Grouped');
        vscode.window.setStatusBarMessage(l10n.t('Agent Sort: {0}', orderLabel), 3000);
    });

    // Internal command invoked only from TreeItem.command; intentionally omitted from package.json contributes.commands.
    const switchSessionDirectDisposable = vscode.commands.registerCommand('herdr-collie.switchSessionDirect', async (targetSession: string) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (targetSession) {
            await ctx.switchToSession(targetSession);
        }
    });

    const createSessionDisposable = vscode.commands.registerCommand('herdr-collie.createSession', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const input = await vscode.window.showInputBox({
            prompt: l10n.t('Enter name for new Herdr session'),
            placeHolder: l10n.t('e.g. feature-dev, debug-session'),
            validateInput: validateSessionName
        });
        if (!input || !input.trim()) return;
        await ctx.switchToSession(input.trim());
    });

    const refreshSessionsDisposable = vscode.commands.registerCommand('herdr-collie.refreshSessions', () => {
        ctx.sessionProvider.refresh();
    });

    const switchSessionDisposable = vscode.commands.registerCommand('herdr-collie.switchSession', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const activeSidebarSession = ctx.getActiveSidebarSession();
        const sessions = await fetchActiveSessions();
        const items: SessionQuickPickItem[] = sessions.map(name => ({
            label: name === activeSidebarSession ? `$(check) ${name}` : `$(server) ${name}`,
            description: name === activeSidebarSession ? l10n.t('Current session') : '',
            detail: name === 'default' ? l10n.t('Herdr default persistent session') : l10n.t('Herdr session: {0}', name),
            sessionName: name,
            buttons: name !== 'default' ? [{
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: l10n.t('Stop and delete session "{0}"', name)
            }] : []
        }));

        items.push({
            label: '$(plus) ' + l10n.t('Switch to custom session...'),
            description: l10n.t('Enter a custom session name'),
            detail: '',
            isCustom: true
        });

        const qp = vscode.window.createQuickPick<SessionQuickPickItem>();
        qp.items = items;
        qp.placeholder = l10n.t('Current session: {0}. Select session to switch sidebar view:', activeSidebarSession);
        qp.title = l10n.t('Switch Herdr Session');

        qp.onDidTriggerItemButton(async (e) => {
            qp.hide();
            if (e.item.sessionName) {
                await ctx.performDeleteSession(e.item.sessionName);
            }
        });

        qp.onDidAccept(async () => {
            const selected = qp.selectedItems[0];
            qp.hide();
            if (!selected) return;

            if (selected.isCustom) {
                const input = await vscode.window.showInputBox({
                    prompt: l10n.t('Enter Herdr session name to switch to'),
                    placeHolder: l10n.t('e.g. default, project-x, session-2'),
                    validateInput: validateSessionName
                });
                if (!input || !input.trim()) return;
                await ctx.switchToSession(input.trim());
            } else if (selected.sessionName) {
                await ctx.switchToSession(selected.sessionName);
            }
        });

        qp.onDidHide(() => {
            qp.dispose();
        });

        qp.show();
    });

    const deleteSessionDisposable = vscode.commands.registerCommand('herdr-collie.deleteSession', async (arg?: string | { sessionName?: string }) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        let sessionToDelete: string | undefined;
        if (typeof arg === 'string') {
            sessionToDelete = arg;
        } else if (arg && typeof arg.sessionName === 'string') {
            sessionToDelete = arg.sessionName;
        }
        if (!sessionToDelete) {
            const sessions = (await fetchActiveSessions()).filter(s => s !== 'default');
            if (sessions.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No custom sessions available to delete.'));
                return;
            }
            const selected = await vscode.window.showQuickPick(sessions, {
                placeHolder: l10n.t('Select Herdr Session to delete'),
                title: l10n.t('Delete Session')
            });
            if (!selected) return;
            sessionToDelete = selected;
        }

        await ctx.performDeleteSession(sessionToDelete);
    });

    const refreshDisposable = vscode.commands.registerCommand('herdr-collie.refreshWorkspaces', () => {
        ctx.refreshAllProviders();
    });

    const createWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.createWorkspace', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const label = await vscode.window.showInputBox({
            prompt: l10n.t('Enter label / name for the new workspace'),
            placeHolder: l10n.t('e.g. backend, frontend, docs')
        });

        if (label === undefined) return;

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const createArgs = ['--session', ctx.getActiveSidebarSession(), 'workspace', 'create', '--cwd', cwd];
        if (label) {
            createArgs.push('--label', label);
        }

        execHerdr(createArgs, (error) => {
            if (error) {
                vscode.window.showErrorMessage(l10n.t('Failed to create workspace: {0}', error.message));
                return;
            }
            ctx.refreshAllProviders();
        });
    });

    const renameWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.renameWorkspace', async (item: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (!item) return;
        const targetId = item.rawId || (item.id ? item.id.split(':')[0] : '');
        if (!targetId) return;

        const currentLabel = item.label.replace('★ ', '').replace(/\(\d+ panes\)/, '').trim();

        const newLabel = await vscode.window.showInputBox({
            prompt: l10n.t('Enter new label for workspace "{0}"', item.label || targetId),
            value: currentLabel
        });

        if (!newLabel) return;

        execHerdr(['--session', ctx.getActiveSidebarSession(), 'workspace', 'rename', targetId, newLabel], (error) => {
            if (error) {
                vscode.window.showErrorMessage(l10n.t('Failed to rename workspace: {0}', error.message));
                return;
            }
            ctx.refreshAllProviders();
        });
    });

    const closeWorkspaceDisposable = vscode.commands.registerCommand('herdr-collie.closeWorkspace', async (item: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (!item) return;
        const targetId = item.rawId || (item.id ? item.id.split(':')[0] : '');
        if (!targetId) return;
        const closeBtn = l10n.t('Close Workspace');
        const confirm = await vscode.window.showWarningMessage(
            l10n.t('Are you sure you want to close workspace "{0}"? All running panes inside it will be terminated.', item.label || targetId),
            { modal: true },
            closeBtn
        );

        if (confirm !== closeBtn) return;

        execHerdr(['--session', ctx.getActiveSidebarSession(), 'workspace', 'close', targetId], (error) => {
            if (error) {
                vscode.window.showErrorMessage(l10n.t('Failed to close workspace: {0}', error.message));
                return;
            }
            ctx.refreshAllProviders();
        });
    });

    const openWorkspaceInNewWindowDisposable = vscode.commands.registerCommand('herdr-collie.openWorkspaceInNewWindow', async (item?: HerdrWorkspaceTreeItem) => {
        let targetPath = item?.cwd;
        let targetLabel = item?.label || '';
        const socketClient = ctx.getSocketClient();

        if (!targetPath) {
            if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
            const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            let candidates: { label: string; description: string; detail: string; cwd: string }[] = [];

            if (socketClient.isConnected) {
                const snapshot = await socketClient.getSnapshot();
                if (snapshot) {
                    const parsedWs = parseSnapshotWorkspaces(snapshot, os.homedir());
                    const parsedAg = parseSnapshotAgents(snapshot, parsedWs);
                    const worktrees = await getWorktreesForCwds(parsedWs.map(w => w.cwd));
                    for (const ws of parsedWs) {
                        if (!ws.cwd) continue;
                        const displayInfo = formatWorkspaceDisplay(ws, worktrees, parsedAg, currentFolder);
                        candidates.push({
                            label: `$(${displayInfo.iconId}) ${displayInfo.label}`,
                            description: displayInfo.description,
                            detail: ws.cwd,
                            cwd: ws.cwd
                        });
                    }
                }
            }

            if (candidates.length === 0) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const repoRoot = await getRepoRoot(workspaceFolders[0].uri.fsPath);
                    if (repoRoot) {
                        const worktrees = await listGitWorktrees(repoRoot);
                        candidates = worktrees.map(wt => ({
                            label: `$(git-branch) ${wt.branch || path.basename(wt.worktree)}`,
                            description: wt.isMain ? l10n.t('(current branch)') : '',
                            detail: wt.worktree,
                            cwd: wt.worktree
                        }));
                    }
                }
            }

            if (candidates.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No Herdr workspaces found.'));
                return;
            }

            const selected = await vscode.window.showQuickPick(candidates, {
                title: l10n.t('Open Workspace in New Window'),
                placeHolder: l10n.t('Select Herdr Workspace or Worktree to open in a new VS Code window')
            });
            if (!selected) return;
            targetPath = selected.cwd;
            targetLabel = selected.label;
        }

        const opened = await openWorkspaceFolderInWindow(targetPath, true);
        if (!opened) {
            vscode.window.showWarningMessage(
                l10n.t('Workspace directory path is not available or does not exist: {0}', targetPath || targetLabel || 'Unknown')
            );
        }
    });

    const focusTabDisposable = vscode.commands.registerCommand('herdr-collie.focusTab', async (tabId?: string, workspaceId?: string, sessionArg?: string) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (!tabId) return;
        const targetSession = sessionArg || ctx.getActiveSidebarSession();
        const wsId = workspaceId || (tabId.includes(':') ? tabId.split(':')[0] : '');
        await ctx.openOrAttachTerminal(wsId, false, `Tab ${tabId}`, targetSession, undefined, tabId);
    });

    const createTabDisposable = vscode.commands.registerCommand('herdr-collie.createTab', async (item?: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const workspaceId = item?.rawId;
        const sessionName = ctx.getActiveSidebarSession();
        const args = ['--session', sessionName, 'tab', 'create'];
        if (workspaceId) {
            args.push('--workspace', workspaceId);
        }
        execHerdr(args, (err) => {
            if (err) {
                vscode.window.showErrorMessage(l10n.t('Failed to create tab: {0}', err.message));
                return;
            }
            ctx.refreshAllProviders();
            vscode.window.showInformationMessage(l10n.t('Tab created successfully.'));
        });
    });

    const closeTabDisposable = vscode.commands.registerCommand('herdr-collie.closeTab', async (item?: HerdrTabTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (!item || !item.tabId) return;
        const sessionName = ctx.getActiveSidebarSession();
        const closeBtn = l10n.t('Close Tab');
        const confirm = await vscode.window.showWarningMessage(
            l10n.t('Are you sure you want to close tab "{0}"?', item.label || item.tabId),
            { modal: true },
            closeBtn
        );
        if (confirm !== closeBtn) return;

        execHerdr(['--session', sessionName, 'tab', 'close', item.tabId], (err) => {
            if (err) {
                vscode.window.showErrorMessage(l10n.t('Failed to close tab: {0}', err.message));
                return;
            }
            ctx.refreshAllProviders();
        });
    });

    const peekAgentOutputDisposable = vscode.commands.registerCommand('herdr-collie.peekAgentOutput', async (item?: HerdrWorkspaceTreeItem | TargetQuickPickItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const targetSession = ctx.getActiveSidebarSession();
        const socketClient = ctx.getSocketClient();
        let targetAgent = (item && 'rawId' in item) ? item.rawId : (item && 'targetId' in item ? item.targetId : undefined);

        if (!targetAgent) {
            if (socketClient.isConnected) {
                const snapshot = await socketClient.getSnapshot();
                const agents = parseSnapshotAgents(snapshot);
                if (agents.length > 0) {
                    const picked = await vscode.window.showQuickPick(agents.map(a => ({
                        label: `${a.statusIcon} ${a.name}`,
                        description: a.status,
                        detail: a.id,
                        agentId: a.id
                    })), { placeHolder: l10n.t('Select agent to peek output:') });
                    if (!picked) return;
                    targetAgent = picked.agentId;
                }
            }
        }

        if (!targetAgent) {
            vscode.window.showInformationMessage(l10n.t('No active agent selected to inspect.'));
            return;
        }

        if (!agentOutputChannel) {
            agentOutputChannel = vscode.window.createOutputChannel('Herdr Agent Output');
            context.subscriptions.push(agentOutputChannel);
        }

        execHerdr(['--session', targetSession, 'agent', 'read', targetAgent, '--source', 'recent-unwrapped', '--lines', '50'], (err, stdout) => {
            if (err) {
                vscode.window.showErrorMessage(l10n.t('Failed to read agent output: {0}', err.message));
                return;
            }
            agentOutputChannel!.clear();
            agentOutputChannel!.appendLine(`=== Herdr Agent Output [${targetAgent}] (${new Date().toLocaleTimeString()}) ===\n`);
            agentOutputChannel!.appendLine(stdout || l10n.t('(No output available)'));
            agentOutputChannel!.show(true);
        });
    });

    const showAgentHUDDisposable = vscode.commands.registerCommand('herdr-collie.showAgentHUD', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        await ctx.agentHUD.showHUDQuickPick();
    });

    context.subscriptions.push(
        attachWorkspaceDisposable,
        selectAgentDisposable,
        selectWorkspaceDisposable,
        toggleAgentSortDisposable,
        switchSessionDirectDisposable,
        createSessionDisposable,
        refreshSessionsDisposable,
        switchSessionDisposable,
        deleteSessionDisposable,
        refreshDisposable,
        createWorkspaceDisposable,
        renameWorkspaceDisposable,
        closeWorkspaceDisposable,
        openWorkspaceInNewWindowDisposable,
        focusTabDisposable,
        createTabDisposable,
        closeTabDisposable,
        peekAgentOutputDisposable,
        showAgentHUDDisposable
    );
}
