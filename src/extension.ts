/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execHerdr, ensureSessionServerRunning, isCommandAvailable, setPreServerStartHook } from './executors';
import {
    findAgentForWorktree,
    findMatchingWorkspaceForCwd,
    AgentSortOrder
} from './formatters';
import {
    parseWorkspaces,
    parsePanes,
    GitWorktreeInfo
} from './parsers';
import { HerdrSocketClient, getSessionSocketPath, validateSessionName } from './socketClient';
import { setupConfigManager, reloadConfigForSessions, ConfigManagerHandle } from './configManager';
import { AgentHUD } from './agentHUD';
import { WorkspaceHUD } from './workspaceHUD';
import {
    getRepoRoot,
    getCurrentGitBranch,
    listGitWorktrees,
    collectWorktreeScorecardMap,
    WorktreeScorecard
} from './worktreeManager';
import {
    HerdrWorkspaceTreeItem,
    WorkspaceDragAndDropController,
    AutoSelectionState,
    resolveWorkspaceAutoSelection,
    resolveAgentAutoSelection
} from './workspaceDragAndDrop';
import {
    HerdrReviewController,
    HerdrReviewChangesProvider,
    ReviewViewMode,
    ReviewTarget,
    resolveWorktreeMergeBase
} from './reviewManager';
import {
    HerdrQuickFixProvider,
    HerdrCodeLensProvider
} from './microTaskManager';
import { TerminalShellMonitor } from './terminalShellManager';
import { WorktreeConflictRadar } from './conflictRadar';
import { isWorkspaceTrusted } from './workspaceTrust';
import {
    invalidateWorktreeCache,
    getWorktreesForCwds,
    computeGitRelativePath,
    resolveGitContextForUri,
    resolveMainRepositoryRoot,
    captureTerminalOutputWithClipboard,
    isHerdrRunningInTerminal
} from './gitContext';
import { HerdrSessionProvider, HerdrWorkspaceProvider } from './sidebarProviders';
import {
    getSessionName,
    fetchActiveSessions,
    createTerminalBridge,
    createSessionSwitchCoordinator,
    sendPromptToHerdr
} from './herdrBridge';
import { CommandContext } from './commands/types';
import { registerSessionCommands } from './commands/sessionCommands';
import { registerContextCommands } from './commands/contextCommands';
import { registerWorktreeCommands } from './commands/worktreeCommands';
import { registerReviewCommands } from './commands/reviewCommands';

export {
    computeGitRelativePath,
    resolveGitContextForUri,
    captureTerminalOutputWithClipboard,
    isHerdrRunningInTerminal
};

export function activate(context: vscode.ExtensionContext) {
    if (vscode.l10n?.bundle) {
        try {
            l10n.config({ contents: vscode.l10n.bundle as any });
        } catch {
            // Ignore in test environments
        }
    } else if (vscode.l10n?.uri) {
        try {
            l10n.config({ fsPath: vscode.l10n.uri.fsPath });
        } catch {
            // Ignore in non-file URI or test environments
        }
    }

    const initialSession = getSessionName();
    let activeSidebarSession = initialSession;
    const getActiveSidebarSession = () => activeSidebarSession;

    // Setup Herdr embedded config lazily when workspace is trusted; wait for initial sync before spawning session server
    let configManager: ConfigManagerHandle | null = null;
    const ensureConfigManagerInitialized = (): ConfigManagerHandle => {
        if (!configManager) {
            configManager = setupConfigManager(context, vscode, getActiveSidebarSession);
        }
        return configManager;
    };

    const ensureSessionServerAfterConfigReady = async (sessionName?: string): Promise<boolean> => {
        if (!isWorkspaceTrusted(vscode)) {
            return false;
        }
        const cm = ensureConfigManagerInitialized();
        await cm.ready.catch(() => undefined);
        await cm.whenIdle().catch(() => undefined);
        return await ensureSessionServerRunning(sessionName);
    };

    setPreServerStartHook(async () => {
        if (!isWorkspaceTrusted(vscode)) {
            return;
        }
        const cm = ensureConfigManagerInitialized();
        await cm.ready.catch(() => undefined);
        await cm.whenIdle().catch(() => undefined);
    });
    context.subscriptions.push({ dispose: () => setPreServerStartHook(null) });

    const isAutoStartServerEnabled = (): boolean =>
        Boolean(vscode.workspace.getConfiguration('herdr-collie').get<boolean>('autoStartServer', false));

    const hasExistingSessionSocket = (sessionName?: string): boolean => {
        try {
            return fs.existsSync(getSessionSocketPath(sessionName));
        } catch {
            return false;
        }
    };

    // Only auto-start daemon on startup when opt-in `autoStartServer` is enabled;
    // otherwise connect passively only if an active session socket already exists.
    const initialTrusted = isWorkspaceTrusted(vscode);
    const shouldAutoStartOnActivation = initialTrusted && isAutoStartServerEnabled();
    const shouldConnectOnActivation = initialTrusted && (shouldAutoStartOnActivation || hasExistingSessionSocket(initialSession));

    let sessionServerReadyPromise = shouldAutoStartOnActivation
        ? ensureSessionServerAfterConfigReady(initialSession).catch(() => false)
        : Promise.resolve(false);

    let socketClient = new HerdrSocketClient(activeSidebarSession);
    if (shouldConnectOnActivation) {
        socketClient.connect();
    }

    let refreshAllProviders: (options?: { includeHUDs?: boolean; includeSessions?: boolean; snapshotMaxAgeMs?: number }) => void = () => {};

    const terminalBridge = createTerminalBridge(() => refreshAllProviders(), {
        ensureServerRunning: ensureSessionServerAfterConfigReady
    });
    terminalBridge.restoreTerminalIfNeeded(initialSession).catch(() => {});
    terminalBridge.registerListeners(context, getActiveSidebarSession);

    const sendToHerdr = (
        richText: string,
        successMsg: string,
        quickPickTitle: string,
        options?: { stageOnly?: boolean; preferredCwd?: string; preferredAgentId?: string }
    ): Promise<boolean> => {
        return sendPromptToHerdr({
            activeSidebarSession,
            socketClient,
            richText,
            successMsg,
            quickPickTitle,
            options
        });
    };

    const terminalShellMonitor = new TerminalShellMonitor(
        (prompt, successMsg, quickPickTitle, options) => sendToHerdr(prompt, successMsg, quickPickTitle, options),
        async () => {
            await vscode.commands.executeCommand('herdr-collie.sendTerminalOutput');
        }
    );
    context.subscriptions.push(terminalShellMonitor);

    // Feature 3: GUI Sidebar Manager (Socket-driven) & Agent/Workspace HUD
    const sessionProvider = new HerdrSessionProvider(getActiveSidebarSession, fetchActiveSessions);
    const agentHUD = new AgentHUD(socketClient, getActiveSidebarSession);
    const workspaceProvider = new HerdrWorkspaceProvider('workspaces', socketClient, getActiveSidebarSession, context.extensionUri);
    const agentProvider = new HerdrWorkspaceProvider('agents', socketClient, getActiveSidebarSession, context.extensionUri, (agents) => agentHUD.enrichAgentsWithStateMetadata(agents));
    const workspaceHUD = new WorkspaceHUD(socketClient, getActiveSidebarSession, getWorktreesForCwds);
    const workspaceDragAndDropController = new WorkspaceDragAndDropController(
        () => workspaceProvider.getCurrentItems(),
        () => socketClient,
        () => refreshAllProviders()
    );

    const initialSort = vscode.workspace.getConfiguration('herdr-collie').get<AgentSortOrder>('agentSortOrder', 'grouped') || 'grouped';
    agentProvider.setSortOrder(initialSort);

    // P3: Integrated Review Controller & Status Bar
    const reviewController = new HerdrReviewController();
    const reviewStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    reviewStatusBarItem.command = 'herdr-collie.submitReview';

    const updateReviewStatusBar = (count: number) => {
        if (count > 0) {
            reviewStatusBarItem.text = `$(comment-discussion) ${l10n.t('Review ({0})', count)}`;
            reviewStatusBarItem.tooltip = l10n.t('Review: {0} comments pending (Click to submit to agent)', count);
            reviewStatusBarItem.show();
        } else {
            reviewStatusBarItem.hide();
        }
    };
    if (reviewController.onDidUpdateComments) {
        context.subscriptions.push(
            reviewController.onDidUpdateComments(comments => updateReviewStatusBar(comments.length))
        );
    }

    context.subscriptions.push(
        sessionProvider,
        workspaceProvider,
        agentProvider,
        agentHUD,
        workspaceHUD,
        reviewController,
        reviewStatusBarItem,
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

    const updateAgentBadge = (count: number) => {
        if (count > 0) {
            agentTreeView.badge = {
                value: count,
                tooltip: l10n.t('{0} agents waiting for confirmation', count)
            };
        } else {
            agentTreeView.badge = undefined;
        }
    };

    updateAgentBadge(agentHUD.getBlockedCount());
    context.subscriptions.push(agentHUD.onDidChangeBlockedCount(updateAgentBadge));

    // When user opens any Herdr sidebar view in a trusted workspace, connect socket if a session socket exists
    const connectIfVisibleAndTrusted = (visible: boolean) => {
        if (visible && isWorkspaceTrusted(vscode) && !socketClient.isConnected && hasExistingSessionSocket(activeSidebarSession)) {
            socketClient.retryNow();
        }
    };
    context.subscriptions.push(
        sessionTreeView.onDidChangeVisibility(e => connectIfVisibleAndTrusted(e.visible)),
        workspaceTreeView.onDidChangeVisibility(e => connectIfVisibleAndTrusted(e.visible)),
        agentTreeView.onDidChangeVisibility(e => connectIfVisibleAndTrusted(e.visible))
    );

    const getActiveRepoRoot = async (): Promise<string | null> => {
        const gitCtx = await resolveGitContextForUri(undefined, vscode.window.activeTextEditor?.document.uri);
        if (!gitCtx) return null;
        try {
            return await getRepoRoot(gitCtx.cwd);
        } catch {
            return null;
        }
    };

    const reviewChangesProvider = new HerdrReviewChangesProvider(getActiveRepoRoot);
    const reviewChangesTreeView = vscode.window.createTreeView('herdr-collie.reviewChanges', {
        treeDataProvider: reviewChangesProvider
    });

    context.subscriptions.push(sessionTreeView, workspaceTreeView, agentTreeView, reviewChangesProvider, reviewChangesTreeView);

    // Bidirectional selection synchronization between Workspaces and Agents
    let isSyncingSelection = false;

    context.subscriptions.push(
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
        }),
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
        })
    );

    // Automatically highlight the active workspace and its agent without overriding intentional user selection
    const autoSelectionState: AutoSelectionState = {};
    let pendingAgentSyncFromFocusChange = false;

    const syncActiveSelection = async () => {
        if (isSyncingSelection) return;
        const allWs = workspaceProvider.getCurrentItems();
        if (allWs.length === 0) return;

        const currentSelected = workspaceTreeView.selection[0] as HerdrWorkspaceTreeItem | undefined;
        const { target: targetWs, focusChanged } = resolveWorkspaceAutoSelection(allWs, currentSelected, autoSelectionState);
        if (focusChanged) {
            pendingAgentSyncFromFocusChange = true;
        }

        if (targetWs) {
            isSyncingSelection = true;
            try {
                await workspaceTreeView.reveal(targetWs, { select: true, focus: false });
            } catch {
            } finally {
                isSyncingSelection = false;
            }
        }

        const focusedWs = allWs.find(w => w.isFocused) || allWs[0];
        const allAgents = agentProvider.getCurrentItems();
        if (allAgents.length > 0 && focusedWs) {
            const currentAgentSelected = agentTreeView.selection[0] as HerdrWorkspaceTreeItem | undefined;
            const targetAgent = resolveAgentAutoSelection(
                allAgents,
                focusedWs,
                currentAgentSelected,
                pendingAgentSyncFromFocusChange
            );
            pendingAgentSyncFromFocusChange = false;
            if (targetAgent) {
                isSyncingSelection = true;
                try {
                    await agentTreeView.reveal(targetAgent, { select: true, focus: false });
                } catch {
                } finally {
                    isSyncingSelection = false;
                }
            }
        }
    };

    let syncSelectionTimer: NodeJS.Timeout | null = null;
    const scheduleSyncActiveSelection = () => {
        if (syncSelectionTimer) {
            clearTimeout(syncSelectionTimer);
        }
        syncSelectionTimer = setTimeout(() => {
            syncSelectionTimer = null;
            void syncActiveSelection();
        }, 60);
    };

    context.subscriptions.push(
        workspaceProvider.onDidUpdateItems(scheduleSyncActiveSelection),
        agentProvider.onDidUpdateItems(scheduleSyncActiveSelection)
    );

    const updateTreeViewDescriptions = () => {
        workspaceTreeView.description = undefined;
        const sort = agentProvider.getSortOrder();
        agentTreeView.description = sort === 'priority' ? l10n.t('Priority') : l10n.t('Grouped');
        const reviewMode = reviewChangesProvider.getViewMode();
        const modeLabel = reviewMode === 'tree' ? l10n.t('Tree') : l10n.t('Flat');
        const reviewTarget = reviewChangesProvider.getReviewTarget();
        if (reviewTarget && reviewTarget.kind === 'worktree') {
            reviewChangesTreeView.description = `${reviewTarget.label} (${modeLabel})`;
        } else {
            reviewChangesTreeView.description = modeLabel;
        }
    };
    updateTreeViewDescriptions();

    let refreshDebounceTimer: NodeJS.Timeout | null = null;
    let pendingIncludeHUDs = false;
    let pendingIncludeSessions = false;
    let pendingSnapshotMaxAgeMs = 0;
    const scheduleRefreshAllProviders = (
        delayMs = 120,
        options?: { includeHUDs?: boolean; includeSessions?: boolean; snapshotMaxAgeMs?: number }
    ) => {
        if (options?.includeHUDs ?? true) {
            pendingIncludeHUDs = true;
        }
        if (options?.includeSessions ?? true) {
            pendingIncludeSessions = true;
        }
        if (typeof options?.snapshotMaxAgeMs === 'number') {
            pendingSnapshotMaxAgeMs = Math.max(pendingSnapshotMaxAgeMs, options.snapshotMaxAgeMs);
        }
        if (refreshDebounceTimer) {
            clearTimeout(refreshDebounceTimer);
        }
        refreshDebounceTimer = setTimeout(() => {
            refreshDebounceTimer = null;
            const includeHUDs = pendingIncludeHUDs;
            const includeSessions = pendingIncludeSessions;
            const snapshotMaxAgeMs = pendingSnapshotMaxAgeMs;
            pendingIncludeHUDs = false;
            pendingIncludeSessions = false;
            pendingSnapshotMaxAgeMs = 0;
            refreshAllProviders({ includeHUDs, includeSessions, snapshotMaxAgeMs });
        }, delayMs);
    };

    let conflictRadar: WorktreeConflictRadar | undefined;

    refreshAllProviders = (options?: { includeHUDs?: boolean; includeSessions?: boolean; snapshotMaxAgeMs?: number }) => {
        const includeHUDs = options?.includeHUDs ?? true;
        const includeSessions = options?.includeSessions ?? true;
        const maxAgeMs = options?.snapshotMaxAgeMs ?? 0;
        if (includeHUDs) {
            invalidateWorktreeCache();
        }
        if (includeSessions) {
            sessionProvider.refresh();
        }
        workspaceProvider.refresh({ maxAgeMs });
        agentProvider.refresh({ maxAgeMs });
        if (includeHUDs) {
            void agentHUD.refresh({ maxAgeMs });
            void workspaceHUD.refresh({ maxAgeMs });
            conflictRadar?.scheduleScan(800);
        }
    };

    let socketListenerDisposable: vscode.Disposable | null = null;
    const setupSocketListeners = (client: HerdrSocketClient): vscode.Disposable => {
        const onConnect = () => scheduleRefreshAllProviders(50, { includeHUDs: false, includeSessions: true });
        const onEvent = () => scheduleRefreshAllProviders(120, { includeHUDs: false, includeSessions: false, snapshotMaxAgeMs: 150 });
        const onDisconnect = () => scheduleRefreshAllProviders(50, { includeHUDs: false, includeSessions: true });
        const onError = () => {};

        client.on('connect', onConnect);
        client.on('event', onEvent);
        client.on('disconnect', onDisconnect);
        client.on('error', onError);

        return {
            dispose: () => {
                client.off('connect', onConnect);
                client.off('event', onEvent);
                client.off('disconnect', onDisconnect);
                client.off('error', onError);
            }
        };
    };
    socketListenerDisposable = setupSocketListeners(socketClient);
    context.subscriptions.push({
        dispose: () => {
            socketListenerDisposable?.dispose();
            socketListenerDisposable = null;
        }
    });

    if (!isWorkspaceTrusted(vscode)) {
        refreshAllProviders();
    } else {
        // Allow initial async socket connect to succeed before triggering CLI fallback refresh
        const initialRefreshFallbackTimer = setTimeout(() => {
            if (!socketClient.isConnected) {
                refreshAllProviders({ includeHUDs: false, includeSessions: true });
            }
        }, 250);
        context.subscriptions.push({ dispose: () => clearTimeout(initialRefreshFallbackTimer) });
    }

    if (typeof vscode.window.onDidChangeWindowState === 'function') {
        context.subscriptions.push(
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused && isWorkspaceTrusted(vscode) && !socketClient.isConnected) {
                    if (isAutoStartServerEnabled() || hasExistingSessionSocket(activeSidebarSession)) {
                        socketClient.retryNow();
                    }
                }
            })
        );
    }

    // Background safety net polling (relaxed from 1.2s to 10s to prevent socket FD exhaustion)
    const statusPollInterval = setInterval(() => {
        if (socketClient && socketClient.isConnected) {
            scheduleRefreshAllProviders(50, { includeHUDs: true });
        }
    }, 10000);
    context.subscriptions.push({
        dispose: () => {
            clearInterval(statusPollInterval);
            if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
            if (syncSelectionTimer) clearTimeout(syncSelectionTimer);
        }
    });

    // Instant sync when user refocuses the VS Code window
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                scheduleRefreshAllProviders(50);
            }
        })
    );

    const sessionSwitchCoordinator = createSessionSwitchCoordinator();

    const replaceSessionSocket = (newSession: string) => {
        socketListenerDisposable?.dispose();
        socketClient.dispose();
        socketClient = new HerdrSocketClient(newSession);
        socketClient.connect();
        socketListenerDisposable = setupSocketListeners(socketClient);
        workspaceProvider.updateSocketClient(socketClient, { refresh: false });
        agentProvider.updateSocketClient(socketClient, { refresh: false });
        agentHUD.updateSocketClient(socketClient, { refresh: false });
        workspaceHUD.updateSocketClient(socketClient, { refresh: false });
        workspaceDragAndDropController.updateSocketClient(socketClient);
        updateTreeViewDescriptions();
        refreshAllProviders();
    };

    const shouldSkipSessionSwitch = (targetSession: string): boolean => {
        if (!targetSession) return true;
        const pending = sessionSwitchCoordinator.getPendingTarget();
        if (pending === null && targetSession === activeSidebarSession) return true;
        if (pending === targetSession) return true;
        return false;
    };

    const runSessionServerSwitch = (
        targetSession: string,
        onActivated: () => void
    ): Promise<boolean> => {
        let serverStarted = false;
        const switchPromise = sessionSwitchCoordinator.runSwitch(targetSession, async (isLatest) => {
            serverStarted = await ensureSessionServerAfterConfigReady(targetSession);
            if (!isLatest()) {
                return;
            }
            activeSidebarSession = targetSession;
            onActivated();
        });
        sessionServerReadyPromise = switchPromise.then((applied) => applied && serverStarted).catch(() => false);
        return switchPromise;
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('herdr-collie.sessionName') && isWorkspaceTrusted(vscode)) {
                const newSession = getSessionName();
                if (!shouldSkipSessionSwitch(newSession)) {
                    await runSessionServerSwitch(newSession, () => {
                        replaceSessionSocket(newSession);
                    });
                }
            }
            if (e.affectsConfiguration('herdr-collie.agentSortOrder')) {
                const newSort = vscode.workspace.getConfiguration('herdr-collie').get<AgentSortOrder>('agentSortOrder', 'grouped') || 'grouped';
                agentProvider.setSortOrder(newSort);
                updateTreeViewDescriptions();
            }
            if (e.affectsConfiguration('herdr-collie.reviewChanges.viewMode')) {
                const newMode = vscode.workspace.getConfiguration('herdr-collie').get<ReviewViewMode>('reviewChanges.viewMode', 'tree') || 'tree';
                reviewChangesProvider.setViewMode(newMode);
                updateTreeViewDescriptions();
            }
        })
    );

    const switchToSession = async (targetSession: string) => {
        if (!targetSession || validateSessionName(targetSession) !== null) return;
        if (shouldSkipSessionSwitch(targetSession)) return;

        const applied = await runSessionServerSwitch(targetSession, () => {
            if (vscode.workspace.getConfiguration('herdr-collie').get<boolean>('hideHerdrSidebar', true)) {
                reloadConfigForSessions(targetSession);
            }
            replaceSessionSocket(targetSession);
        });
        if (applied) {
            vscode.window.showInformationMessage(l10n.t('Herdr Collie view switched to session "{0}"', targetSession));
        }
    };

    const performDeleteSession = async (sessionToDelete: string) => {
        const trimmedSession = sessionToDelete ? sessionToDelete.trim() : '';
        if (!trimmedSession || trimmedSession === 'default') {
            vscode.window.showWarningMessage(l10n.t('The "default" session cannot be deleted.'));
            return;
        }
        const validationError = validateSessionName(trimmedSession);
        if (validationError) {
            vscode.window.showWarningMessage(l10n.t('Invalid session name: {0}', validationError));
            return;
        }

        const deleteBtn = l10n.t('Delete Session');
        const answer = await vscode.window.showWarningMessage(
            l10n.t('Are you sure you want to delete session "{0}"? This will terminate all its workspaces and panes.', trimmedSession),
            { modal: true },
            deleteBtn
        );

        if (answer !== deleteBtn) return;

        execHerdr(['session', 'stop', trimmedSession], { skipAutoStart: true }, () => {
            execHerdr(['session', 'delete', trimmedSession], { skipAutoStart: true }, async (err) => {
                if (err) {
                    vscode.window.showErrorMessage(l10n.t('Failed to delete session: {0}', err.message));
                    return;
                }
                vscode.window.showInformationMessage(l10n.t('Session "{0}" deleted.', trimmedSession));

                if (activeSidebarSession === trimmedSession) {
                    const fallbackSession = getSessionName() !== trimmedSession ? getSessionName() : 'default';
                    await switchToSession(fallbackSession);
                } else {
                    refreshAllProviders();
                }
            });
        });
    };

    // Auto-bind VS Code workspace to Herdr workspace safely without duplicates (only when opt-in autoStartServer is enabled)
    let hasAutoBoundWorkspace = false;
    const autoBindWorkspaceIfTrusted = () => {
        if (hasAutoBoundWorkspace || !isWorkspaceTrusted(vscode) || !isAutoStartServerEnabled()) {
            return;
        }
        const currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const rawWsName = vscode.workspace.name || (currentCwd ? path.basename(currentCwd) : 'VSCode Workspace');
        const wsName = rawWsName.trim().replace(/^-+/, '') || 'workspace';
        if (!currentCwd) {
            return;
        }
        hasAutoBoundWorkspace = true;
        void (async () => {
            let awaitedReadyPromise: Promise<boolean>;
            do {
                awaitedReadyPromise = sessionServerReadyPromise;
                await awaitedReadyPromise;
            } while (awaitedReadyPromise !== sessionServerReadyPromise);
            if (!(await isCommandAvailable('herdr'))) {
                return;
            }
            execHerdr(['--session', activeSidebarSession, 'pane', 'list'], (pErr, pStdout) => {
                const parsedPanes = (!pErr && pStdout) ? parsePanes(pStdout) : [];

                execHerdr(['--session', activeSidebarSession, 'workspace', 'list'], (wErr, wStdout) => {
                    if (!wErr && wStdout) {
                        const parsedWs = parseWorkspaces(wStdout, parsedPanes, os.homedir());
                        const matchedWs = findMatchingWorkspaceForCwd(parsedWs, currentCwd, wsName);
                        if (matchedWs) {
                            execHerdr(['--session', activeSidebarSession, 'workspace', 'focus', matchedWs.id], () => refreshAllProviders());
                            return;
                        }

                        execHerdr(['--session', activeSidebarSession, 'workspace', 'create', '--cwd', currentCwd, '--label', wsName], () => refreshAllProviders());
                    }
                });
            });
        })();
    };
    autoBindWorkspaceIfTrusted();

    if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
        context.subscriptions.push(
            vscode.workspace.onDidGrantWorkspaceTrust(() => {
                const previousSession = activeSidebarSession;
                const currentSession = getSessionName();
                reviewChangesProvider.refresh();
                const autoStart = isAutoStartServerEnabled();
                if (autoStart || hasExistingSessionSocket(currentSession)) {
                    if (autoStart) {
                        void runSessionServerSwitch(currentSession, () => {
                            if (currentSession !== previousSession) {
                                replaceSessionSocket(currentSession);
                            } else {
                                socketClient.connect();
                                refreshAllProviders();
                            }
                        }).catch(() => {});
                    } else if (currentSession !== previousSession) {
                        activeSidebarSession = currentSession;
                        replaceSessionSocket(currentSession);
                    } else {
                        socketClient.connect();
                        refreshAllProviders();
                    }
                }
                void terminalBridge.restoreTerminalIfNeeded(currentSession).catch(() => {});
                autoBindWorkspaceIfTrusted();
            })
        );
    }

    const loadWorktreeScorecards = async (
        repoRoot: string,
        candidates: GitWorktreeInfo[]
    ): Promise<Map<string, WorktreeScorecard>> => {
        if (candidates.length === 0) {
            return new Map();
        }
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: l10n.t('Analyzing worktree candidates...')
            },
            async () => await collectWorktreeScorecardMap(repoRoot, candidates)
        );
    };

    const resolveMainRepoRoot = async (hintPath?: string): Promise<string | null> => {
        if (hintPath) {
            const fromHint = await resolveMainRepositoryRoot(hintPath).catch(() => null);
            if (fromHint) return fromHint;
        }
        const fromActive = await getActiveRepoRoot();
        if (fromActive) {
            const resolvedActive = await resolveMainRepositoryRoot(fromActive).catch(() => null);
            return resolvedActive || fromActive;
        }
        const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return firstFolder ? await resolveMainRepositoryRoot(firstFolder).catch(() => null) : null;
    };

    const activateWorktreeReviewTarget = async (
        repoRoot: string,
        worktreePath: string,
        branchName?: string,
        labelHint?: string
    ): Promise<void> => {
        const worktrees = await listGitWorktrees(repoRoot).catch(() => [] as GitWorktreeInfo[]);
        const matchedAgent = findAgentForWorktree(
            worktreePath,
            worktrees.map(w => w.worktree),
            agentProvider.getCurrentItems()
        );
        const currentBranch = await getCurrentGitBranch(repoRoot).catch(() => undefined);
        const mergeBase = await resolveWorktreeMergeBase(worktreePath, currentBranch, branchName);
        const label = labelHint || branchName || path.basename(worktreePath);
        const target: ReviewTarget = {
            kind: 'worktree',
            repoRoot,
            worktreePath,
            branchName: branchName || path.basename(worktreePath),
            baseBranch: mergeBase.baseBranch,
            label,
            agentId: matchedAgent?.rawId || (matchedAgent?.id ? matchedAgent.id.split(':')[0] : undefined),
            agentName: typeof matchedAgent?.label === 'string' ? matchedAgent.label : undefined
        };
        reviewChangesProvider.setReviewTarget(target);
        updateTreeViewDescriptions();
        await vscode.commands.executeCommand('herdr-collie.reviewChanges.focus').then(undefined, () => {});
        vscode.window.setStatusBarMessage(
            l10n.t('Reviewing worktree: {0} (base: {1})', target.label, mergeBase.baseLabel),
            5000
        );
    };

    conflictRadar = new WorktreeConflictRadar({
        getRepoRoot: () => resolveMainRepoRoot(),
        getActiveAgents: () => agentProvider.getCurrentItems().map(a => ({
            id: a.rawId || (a.id ? a.id.split(':')[0] : undefined),
            name: typeof a.label === 'string' ? a.label : undefined,
            cwd: a.cwd
        })),
        dispatchPrompt: (prompt, successMsg, quickPickTitle, options) =>
            sendToHerdr(prompt, successMsg, quickPickTitle, options),
        openWorktreeReview: async (worktreePath, branchName) => {
            const root = await resolveMainRepoRoot(worktreePath);
            if (root) {
                await activateWorktreeReviewTarget(root, worktreePath, branchName, branchName);
            }
        }
    });
    context.subscriptions.push(conflictRadar);
    if (isWorkspaceTrusted(vscode)) {
        conflictRadar.scheduleScan(1200);
    }

    // P4: Micro-Task CodeLens & Quick-Fix
    const quickFixProvider = new HerdrQuickFixProvider();
    const quickFixDisposable = vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        quickFixProvider,
        {
            providedCodeActionKinds: HerdrQuickFixProvider.providedCodeActionKinds
        }
    );
    const codeLensProvider = new HerdrCodeLensProvider();
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        codeLensProvider
    );
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('herdr-collie.codeLens') || e.affectsConfiguration('herdr-collie.quickFix')) {
            codeLensProvider.refresh();
        }
    });
    context.subscriptions.push(quickFixDisposable, codeLensProvider, codeLensDisposable, configChangeDisposable);

    const commandCtx: CommandContext = {
        getActiveSidebarSession,
        getSocketClient: () => socketClient,
        refreshAllProviders,
        updateTreeViewDescriptions,
        openOrAttachTerminal: terminalBridge.openOrAttachTerminal,
        sendToHerdr,
        switchToSession,
        performDeleteSession,
        getActiveRepoRoot,
        resolveMainRepoRoot,
        loadWorktreeScorecards,
        activateWorktreeReviewTarget,
        getAgentItems: () => agentProvider.getCurrentItems(),
        sessionProvider,
        agentProvider,
        agentHUD,
        reviewController,
        reviewChangesProvider,
        terminalShellMonitor,
        getConflictRadar: () => conflictRadar
    };

    registerSessionCommands(context, commandCtx);
    registerContextCommands(context, commandCtx);
    registerWorktreeCommands(context, commandCtx);
    registerReviewCommands(context, commandCtx);
}

export function deactivate() {}
