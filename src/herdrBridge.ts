/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as os from 'os';
import { execHerdr, ensureSessionServerRunning } from './executors';
import { isSameOrSubPath } from './formatters';
import {
    parseWorkspaces,
    parseAgents,
    parsePanes,
    parseSessions,
    parseSnapshotWorkspaces,
    parseSnapshotPanes,
    parseSnapshotAgents
} from './parsers';
import { HerdrSocketClient, sanitizeSessionName, normalizeConfiguredSessionName, isSafeCliTargetId } from './socketClient';
import { isWorkspaceTrusted, ensureWorkspaceTrustedForAction } from './workspaceTrust';
import { isHerdrRunningInTerminal } from './gitContext';

export interface TargetQuickPickItem extends vscode.QuickPickItem {
    targetId: string;
    sessionName?: string;
    isAgent?: boolean;
    displayLabel?: string;
    workspaceId?: string;
    priority?: number;
}

export interface SessionQuickPickItem extends vscode.QuickPickItem {
    sessionName?: string;
    isCustom?: boolean;
}

export function getSessionName(): string {
    const config = vscode.workspace.getConfiguration('herdr-collie');
    return normalizeConfiguredSessionName(config.get<string>('sessionName', 'vscode'), 'vscode');
}

export function fetchActiveSessions(extraSession?: string): Promise<string[]> {
    const configuredSession = getSessionName();
    if (!isWorkspaceTrusted(vscode)) {
        const fallback = ['default'];
        if (configuredSession && !fallback.includes(configuredSession)) {
            fallback.push(configuredSession);
        }
        if (extraSession && !fallback.includes(extraSession)) {
            fallback.push(extraSession);
        }
        return Promise.resolve(fallback);
    }
    return new Promise((resolve) => {
        execHerdr(['session', 'list', '--json'], { skipAutoStart: true }, (err, stdout) => {
            if (!err && stdout) {
                const sessions = parseSessions(stdout);
                if (sessions.length > 0) {
                    const sessionNames = sessions.map(s => s.name);
                    if (!sessionNames.includes(configuredSession)) {
                        sessionNames.push(configuredSession);
                    }
                    if (extraSession && !sessionNames.includes(extraSession)) {
                        sessionNames.push(extraSession);
                    }
                    resolve(sessionNames);
                    return;
                }
            }
            const fallback = ['default'];
            if (configuredSession && !fallback.includes(configuredSession)) {
                fallback.push(configuredSession);
            }
            if (extraSession && !fallback.includes(extraSession)) {
                fallback.push(extraSession);
            }
            resolve(fallback);
        });
    });
}

/**
 * Discovers only actively running Herdr sessions without triggering daemon auto-start.
 */
export function fetchRunningSessions(extraConnectedSession?: string): Promise<string[]> {
    if (!isWorkspaceTrusted(vscode)) {
        return Promise.resolve([]);
    }
    return new Promise((resolve) => {
        execHerdr(['session', 'list', '--json'], { skipAutoStart: true }, (err, stdout) => {
            if (!err && stdout) {
                const sessions = parseSessions(stdout);
                if (sessions.length > 0) {
                    const runningNames = sessions.filter(s => s.running).map(s => s.name);
                    if (extraConnectedSession && !runningNames.includes(extraConnectedSession)) {
                        const explicit = sessions.find(s => s.name === extraConnectedSession);
                        if (!explicit || explicit.running) {
                            runningNames.push(extraConnectedSession);
                        }
                    }
                    resolve(runningNames);
                    return;
                }
            }
            resolve(extraConnectedSession ? [extraConnectedSession] : []);
        });
    });
}

export function isHerdrTerminalName(terminalName: string, sessionName?: string): boolean {
    if (!terminalName) {
        return false;
    }
    const sessionLabel = sessionName ? ` (${sessionName})` : '';
    const baseTerminalName = `Herdr${sessionLabel}`;
    return (
        terminalName === baseTerminalName ||
        terminalName === 'Herdr' ||
        terminalName === 'Herdr (default)' ||
        terminalName === 'Herdr (vscode)' ||
        terminalName.startsWith('Herdr (') ||
        terminalName.startsWith('Herdr Workspace:') ||
        terminalName.startsWith('Herdr Workspace (') ||
        terminalName.startsWith('Herdr Agent:') ||
        terminalName.startsWith('Herdr Agent (')
    );
}

export interface TerminalBridge extends vscode.Disposable {
    restoreTerminalIfNeeded(sessionName: string, specificTerminal?: vscode.Terminal): Promise<void>;
    openOrAttachTerminal(
        target: string,
        isAgent: boolean,
        displayLabel: string,
        targetSession: string,
        targetWorkspaceId?: string,
        targetTabId?: string
    ): Promise<void>;
    updateHerdrTerminalContext(terminal?: vscode.Terminal): void;
    registerListeners(context: vscode.ExtensionContext, getActiveSession: () => string): void;
}

export interface SessionSwitchCoordinator {
    begin(): number;
    isLatest(token: number): boolean;
    invalidate(): number;
    getPendingTarget(): string | null;
    runSwitch(targetSession: string, task: (isLatest: () => boolean) => Promise<void>): Promise<boolean>;
}

export function createSessionSwitchCoordinator(): SessionSwitchCoordinator {
    let generation = 0;
    let pendingTarget: string | null = null;
    return {
        begin: () => ++generation,
        isLatest: (token: number) => token === generation,
        invalidate: () => {
            pendingTarget = null;
            return ++generation;
        },
        getPendingTarget: () => pendingTarget,
        runSwitch: async (targetSession: string, task: (isLatest: () => boolean) => Promise<void>): Promise<boolean> => {
            pendingTarget = targetSession;
            const token = ++generation;
            const checkLatest = () => token === generation;
            try {
                await task(checkLatest);
                return checkLatest();
            } finally {
                if (checkLatest()) {
                    pendingTarget = null;
                }
            }
        }
    };
}

export interface TerminalBridgeDeps {
    ensureServerRunning?: (sessionName?: string) => Promise<boolean>;
    isHerdrRunning?: (terminal: vscode.Terminal) => Promise<boolean>;
}

export function createTerminalBridge(
    onAttached: () => void,
    deps?: TerminalBridgeDeps
): TerminalBridge {
    const ensureServerRunning = deps?.ensureServerRunning ?? ensureSessionServerRunning;
    const checkHerdrRunning = deps?.isHerdrRunning ?? isHerdrRunningInTerminal;
    const extensionManagedTerminals = new Set<vscode.Terminal>();
    const pendingTimers = new Set<NodeJS.Timeout>();
    const pendingRestoreTimers = new Map<vscode.Terminal, Set<NodeJS.Timeout>>();
    const inFlightAttachBySession = new Map<string, Promise<void>>();
    const latestAttachSeqBySession = new Map<string, number>();
    let activeTerminalContextSeq = 0;
    let creatingTerminal = false;
    let disposed = false;

    const scheduleTrackedTimeout = (fn: () => void, delayMs: number, restoreTerminal?: vscode.Terminal): NodeJS.Timeout | undefined => {
        if (disposed) {
            return undefined;
        }
        const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            if (restoreTerminal) {
                pendingRestoreTimers.get(restoreTerminal)?.delete(timer);
            }
            if (!disposed) {
                fn();
            }
        }, delayMs);
        pendingTimers.add(timer);
        if (restoreTerminal) {
            let set = pendingRestoreTimers.get(restoreTerminal);
            if (!set) {
                set = new Set<NodeJS.Timeout>();
                pendingRestoreTimers.set(restoreTerminal, set);
            }
            set.add(timer);
        }
        return timer;
    };

    const cancelPendingRestoreTimers = (terminal: vscode.Terminal): void => {
        const timers = pendingRestoreTimers.get(terminal);
        if (!timers) return;
        for (const timer of timers) {
            clearTimeout(timer);
            pendingTimers.delete(timer);
        }
        timers.clear();
        pendingRestoreTimers.delete(terminal);
    };

    function updateHerdrTerminalContext(terminal: vscode.Terminal | undefined = vscode.window.activeTerminal): void {
        if (disposed) {
            return;
        }
        const seq = ++activeTerminalContextSeq;
        const isKnownHerdr = Boolean(
            terminal && (
                extensionManagedTerminals.has(terminal) ||
                isHerdrTerminalName(terminal.name)
            )
        );
        Promise.resolve(
            vscode.commands.executeCommand('setContext', 'herdr-collie.inHerdrTerminal', isKnownHerdr)
        ).catch(() => {});

        if (!terminal || isKnownHerdr || terminal.exitStatus !== undefined || !isWorkspaceTrusted(vscode)) {
            return;
        }

        checkHerdrRunning(terminal).then((running) => {
            if (!disposed && seq === activeTerminalContextSeq && vscode.window.activeTerminal === terminal && running) {
                Promise.resolve(
                    vscode.commands.executeCommand('setContext', 'herdr-collie.inHerdrTerminal', true)
                ).catch(() => {});
            }
        }).catch(() => {});
    }

    function dispose(): void {
        disposed = true;
        activeTerminalContextSeq++;
        for (const timer of pendingTimers) {
            clearTimeout(timer);
        }
        pendingTimers.clear();
        pendingRestoreTimers.clear();
        extensionManagedTerminals.clear();
    }

    async function restoreTerminalIfNeeded(sessionName: string, specificTerminal?: vscode.Terminal): Promise<void> {
        if (vscode.workspace.isTrusted === false) {
            return;
        }
        const config = vscode.workspace.getConfiguration('herdr-collie');
        if (!config.get<boolean>('autoRestoreTerminal', true)) {
            return;
        }

        const sessionLabel = sessionName ? ` (${sessionName})` : '';
        const baseTerminalName = `Herdr${sessionLabel}`;

        const terminal = specificTerminal || vscode.window.terminals.find(t => isHerdrTerminalName(t.name, sessionName));

        if (!terminal || terminal.exitStatus !== undefined) {
            return;
        }

        if (!isHerdrTerminalName(terminal.name, sessionName)) {
            return;
        }

        if (extensionManagedTerminals.has(terminal)) {
            return;
        }

        extensionManagedTerminals.add(terminal);

        // Determine effective target session from terminal name or fallback to sessionName
        let rawEffectiveSession = sessionName;
        const sessionMatch = terminal.name.match(/^Herdr\s*\(([^)]+)\)/);
        if (sessionMatch && sessionMatch[1]) {
            rawEffectiveSession = sessionMatch[1].trim();
        }
        const effectiveSession = sanitizeSessionName(rawEffectiveSession) || 'default';

        // Wait for processId to resolve to ensure shell is spawned
        let processWaitTimer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                terminal.processId,
                new Promise<void>(resolve => {
                    processWaitTimer = scheduleTrackedTimeout(() => resolve(), 1000);
                })
            ]);
        } catch {} finally {
            if (processWaitTimer) {
                clearTimeout(processWaitTimer);
                pendingTimers.delete(processWaitTimer);
            }
        }

        if (disposed) {
            return;
        }

        const isRunning = await isHerdrRunningInTerminal(terminal);
        if (!isRunning && !disposed) {
            await ensureServerRunning(effectiveSession);
            if (disposed) {
                return;
            }
            const sessionFlag = effectiveSession !== 'default' ? `--session ${effectiveSession}` : '';
            const command = `herdr ${sessionFlag}`.trim();
            // Generous shell startup delay (600ms) to ensure zsh/bash completed loading
            scheduleTrackedTimeout(() => {
                if (!disposed && terminal.exitStatus === undefined) {
                    terminal.sendText(command);
                    // Verify if Herdr started; if dropped due to slow shell init, retry once
                    scheduleTrackedTimeout(async () => {
                        if (!disposed && terminal.exitStatus === undefined) {
                            const runningNow = await isHerdrRunningInTerminal(terminal);
                            if (!disposed && !runningNow && terminal.exitStatus === undefined) {
                                terminal.sendText(command);
                            }
                        }
                    }, 1200, terminal);
                }
            }, 600, terminal);
        }
    }

    async function openOrAttachTerminal(
        target: string,
        isAgent: boolean,
        displayLabel: string,
        targetSession: string,
        targetWorkspaceId?: string,
        targetTabId?: string
    ): Promise<void> {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) {
            return;
        }
        if (target && !isSafeCliTargetId(target)) {
            return;
        }
        if (targetTabId && !isSafeCliTargetId(targetTabId)) {
            return;
        }
        if (targetWorkspaceId && !isSafeCliTargetId(targetWorkspaceId)) {
            return;
        }
        const normalizedSession = sanitizeSessionName(targetSession) || 'default';
        const seq = (latestAttachSeqBySession.get(normalizedSession) || 0) + 1;
        latestAttachSeqBySession.set(normalizedSession, seq);

        const prevInFlight = inFlightAttachBySession.get(normalizedSession);
        const runPromise = (async () => {
            if (prevInFlight) {
                try {
                    await prevInFlight;
                } catch {}
            }
            if (disposed || latestAttachSeqBySession.get(normalizedSession) !== seq) {
                return;
            }
            await openOrAttachTerminalInternal(
                target,
                isAgent,
                displayLabel,
                normalizedSession,
                targetWorkspaceId,
                targetTabId
            );
        })().finally(() => {
            if (inFlightAttachBySession.get(normalizedSession) === runPromise) {
                inFlightAttachBySession.delete(normalizedSession);
            }
        });
        inFlightAttachBySession.set(normalizedSession, runPromise);
        return await runPromise;
    }

    async function openOrAttachTerminalInternal(
        target: string,
        isAgent: boolean,
        displayLabel: string,
        normalizedSession: string,
        targetWorkspaceId?: string,
        targetTabId?: string
    ): Promise<void> {
        // Manage a single unified Herdr TUI terminal per session
        const sessionLabel = normalizedSession !== 'default' ? ` (${normalizedSession})` : '';
        const baseTerminalName = `Herdr${sessionLabel}`;
        const terminalName = baseTerminalName;

        // Focus the target in Herdr background beforehand
        if (target) {
            if (isAgent) {
                const wsId = targetWorkspaceId || (target.includes(':') ? target.split(':')[0] : undefined);
                if (wsId) {
                    await new Promise<void>((resolve) => {
                        execHerdr(['--session', normalizedSession, 'workspace', 'focus', wsId], () => resolve());
                    });
                }
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', normalizedSession, 'agent', 'focus', target], () => resolve());
                });
            } else if (targetTabId) {
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', normalizedSession, 'workspace', 'focus', target], () => resolve());
                });
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', normalizedSession, 'tab', 'focus', targetTabId], () => resolve());
                });
            } else {
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', normalizedSession, 'workspace', 'focus', target], () => resolve());
                });
            }
        }

        const sessionFlag = normalizedSession !== 'default' ? `--session ${normalizedSession}` : '';
        const command = `herdr ${sessionFlag}`.trim();

        const existingTerminal = vscode.window.terminals.find(t =>
            t.name === baseTerminalName ||
            (normalizedSession === 'default' && t.name === 'Herdr (default)') ||
            t.name.startsWith(`Herdr Workspace${sessionLabel}:`) ||
            t.name.startsWith(`Herdr Agent${sessionLabel}:`)
        );

        if (existingTerminal) {
            if (existingTerminal.exitStatus !== undefined) {
                existingTerminal.dispose();
                extensionManagedTerminals.delete(existingTerminal);
            } else {
                const isRunning = await isHerdrRunningInTerminal(existingTerminal);
                if (isRunning) {
                    cancelPendingRestoreTimers(existingTerminal);
                    existingTerminal.show();
                    onAttached();
                    return;
                }
                // Cancel any pending restore timer before manually sending the launch command to avoid double launch
                cancelPendingRestoreTimers(existingTerminal);
                // Terminal shell is alive but Herdr is not running (e.g. restored terminal on VS Code restart)
                await ensureServerRunning(normalizedSession);
                existingTerminal.show();
                existingTerminal.sendText(command);
                extensionManagedTerminals.add(existingTerminal);
                const targetType = isAgent ? l10n.t('Agent') : l10n.t('Workspace');
                const label = displayLabel || target || normalizedSession || 'Herdr';
                vscode.window.showInformationMessage(l10n.t('Attached to Herdr{0} ({1}: {2})', sessionLabel, targetType, label));
                onAttached();
                return;
            }
        }

        await ensureServerRunning(normalizedSession);

        const envOverrides: { [key: string]: string | null | undefined } = {
            HERDR_WORKSPACE: null,
            HERDR_PANE_ID: null,
            HERDR_PANE: null,
            HERDR_AGENT: null,
            HERDR_SESSION: null,
            ...(process.env['HERDR_CONFIG_PATH'] ? { HERDR_CONFIG_PATH: process.env['HERDR_CONFIG_PATH'] } : {})
        };

        creatingTerminal = true;
        let terminal: vscode.Terminal;
        try {
            terminal = vscode.window.createTerminal({
                name: terminalName,
                env: envOverrides
            });
            extensionManagedTerminals.add(terminal);
        } finally {
            creatingTerminal = false;
        }
        terminal.show();
        terminal.sendText(command);
        if (vscode.window.activeTerminal === terminal) {
            updateHerdrTerminalContext(terminal);
        }

        const targetType = isAgent ? l10n.t('Agent') : l10n.t('Workspace');
        const label = displayLabel || target || normalizedSession || 'Herdr';
        vscode.window.showInformationMessage(l10n.t('Attached to Herdr{0} ({1}: {2})', sessionLabel, targetType, label));
        onAttached();
    }

    function registerListeners(context: vscode.ExtensionContext, getActiveSession: () => string): void {
        const onDidOpenTerminalDisposable = vscode.window.onDidOpenTerminal((terminal) => {
            if (creatingTerminal) {
                extensionManagedTerminals.add(terminal);
                if (vscode.window.activeTerminal === terminal) {
                    updateHerdrTerminalContext(terminal);
                }
                return;
            }
            const currentSession = getActiveSession();
            restoreTerminalIfNeeded(currentSession, terminal).catch(() => {});
            if (vscode.window.activeTerminal === terminal) {
                updateHerdrTerminalContext(terminal);
            }
        });

        const onDidCloseTerminalDisposable = vscode.window.onDidCloseTerminal((terminal) => {
            cancelPendingRestoreTimers(terminal);
            extensionManagedTerminals.delete(terminal);
            updateHerdrTerminalContext(vscode.window.activeTerminal);
        });

        context.subscriptions.push(onDidOpenTerminalDisposable, onDidCloseTerminalDisposable, { dispose });

        if (typeof vscode.window.onDidChangeActiveTerminal === 'function') {
            context.subscriptions.push(
                vscode.window.onDidChangeActiveTerminal((terminal) => {
                    updateHerdrTerminalContext(terminal);
                })
            );
        }

        const windowWithShellEvents = vscode.window as unknown as {
            onDidStartTerminalShellExecution?: (listener: (e: { terminal: vscode.Terminal; execution?: { commandLine?: { value?: string } } }) => any) => vscode.Disposable;
            onDidEndTerminalShellExecution?: (listener: (e: { terminal: vscode.Terminal }) => any) => vscode.Disposable;
        };

        if (typeof windowWithShellEvents.onDidStartTerminalShellExecution === 'function') {
            context.subscriptions.push(
                windowWithShellEvents.onDidStartTerminalShellExecution((e) => {
                    if (disposed || !e?.terminal || e.terminal !== vscode.window.activeTerminal) {
                        return;
                    }
                    const cmdLine = (e.execution?.commandLine?.value || '').trim();
                    if (/^(?:herdr|[^\s]*\/herdr)(?:\s|$)/.test(cmdLine)) {
                        activeTerminalContextSeq++;
                        Promise.resolve(
                            vscode.commands.executeCommand('setContext', 'herdr-collie.inHerdrTerminal', true)
                        ).catch(() => {});
                    }
                })
            );
        }

        if (typeof windowWithShellEvents.onDidEndTerminalShellExecution === 'function') {
            context.subscriptions.push(
                windowWithShellEvents.onDidEndTerminalShellExecution((e) => {
                    if (e?.terminal === vscode.window.activeTerminal) {
                        updateHerdrTerminalContext(e.terminal);
                    }
                })
            );
        }

        updateHerdrTerminalContext(vscode.window.activeTerminal);
    }

    return {
        restoreTerminalIfNeeded,
        openOrAttachTerminal,
        updateHerdrTerminalContext,
        registerListeners,
        dispose
    };
}

export async function sendPromptToHerdr(params: {
    activeSidebarSession: string;
    socketClient: HerdrSocketClient;
    richText: string;
    successMsg: string;
    quickPickTitle: string;
    options?: { stageOnly?: boolean; preferredCwd?: string; preferredAgentId?: string };
}): Promise<boolean> {
    if (!(await ensureWorkspaceTrustedForAction(vscode))) {
        return false;
    }

    const { activeSidebarSession, socketClient, richText, successMsg, quickPickTitle, options } = params;
    const defaultSession = activeSidebarSession;
    const sessions = await fetchRunningSessions(socketClient.isConnected ? defaultSession : undefined);
    const preferredCwd = options?.preferredCwd;
    const preferredAgentId = options?.preferredAgentId;
    const currentCwd = preferredCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const allItems: TargetQuickPickItem[] = [];
    const primaryItems: TargetQuickPickItem[] = [];
    const otherItems: TargetQuickPickItem[] = [];

    await Promise.all(sessions.map(async (sessionName) => {
        let workspaces: ReturnType<typeof parseWorkspaces> = [];
        let panes: ReturnType<typeof parsePanes> = [];
        let agents: ReturnType<typeof parseAgents> = [];
        let loadedFromSnapshot = false;

        if (sessionName === defaultSession && socketClient.isConnected) {
            const snapshot = await socketClient.getSnapshot();
            if (snapshot) {
                workspaces = parseSnapshotWorkspaces(snapshot, os.homedir());
                panes = parseSnapshotPanes(snapshot);
                agents = parseSnapshotAgents(snapshot, workspaces);
                loadedFromSnapshot = true;
            }
        }

        if (!loadedFromSnapshot) {
            const sessionArgs = ['--session', sessionName];
            const [rawWorkspaces, rawPanes, rawAgents] = await Promise.all([
                new Promise<string>((resolve) => {
                    execHerdr([...sessionArgs, 'workspace', 'list'], { skipAutoStart: true }, (error, stdout) => {
                        resolve(!error && stdout ? stdout : '');
                    });
                }),
                new Promise<string>((resolve) => {
                    execHerdr([...sessionArgs, 'pane', 'list'], { skipAutoStart: true }, (error, stdout) => {
                        resolve(!error && stdout ? stdout : '');
                    });
                }),
                new Promise<string>((resolve) => {
                    execHerdr([...sessionArgs, 'agent', 'list'], { skipAutoStart: true }, (error, stdout) => {
                        resolve(!error && stdout ? stdout : '');
                    });
                })
            ]);
            panes = rawPanes ? parsePanes(rawPanes) : [];
            workspaces = rawWorkspaces ? parseWorkspaces(rawWorkspaces, panes, os.homedir()) : [];
            agents = rawAgents ? parseAgents(rawAgents, workspaces) : [];
        }

        const workspaceCwdById = new Map<string, string>();
        for (const ws of workspaces) {
            if (ws.id && ws.cwd) {
                workspaceCwdById.set(ws.id, ws.cwd);
            }
        }

        const isCurrentSession = sessionName === defaultSession;

        panes.forEach(p => {
            const isMatchedCwd = Boolean(currentCwd && p.cwd && isSameOrSubPath(p.cwd, currentCwd));
            const isPreferredMatch = Boolean(preferredCwd && p.cwd && isSameOrSubPath(p.cwd, preferredCwd));
            const tag = isPreferredMatch
                ? ` (${l10n.t('Target Worktree')})`
                : (isMatchedCwd ? ` (${l10n.t('Current Project')})` : '');
            const priority =
                (isPreferredMatch ? 4 : 0) +
                (isMatchedCwd ? 2 : 0) +
                (isCurrentSession ? 1 : 0);
            const item: TargetQuickPickItem = {
                label: `[${sessionName}] $(terminal) ${l10n.t('Pane: {0}', p.name || p.id)}`,
                description: `${l10n.t('Session: {0}', sessionName)}${p.command ? ` | ${p.command}` : ''}${tag}`,
                targetId: p.id,
                sessionName,
                isAgent: false,
                priority
            };
            allItems.push(item);

            if ((isCurrentSession && isMatchedCwd) || isPreferredMatch) {
                primaryItems.push(item);
            } else {
                otherItems.push(item);
            }
        });

        agents.forEach(a => {
            const agentCwd = a.workspaceCwd || (a.workspaceId ? workspaceCwdById.get(a.workspaceId) : undefined);
            const isMatchedCwd = Boolean(currentCwd && agentCwd && isSameOrSubPath(agentCwd, currentCwd));
            const isPreferredAgent = Boolean(preferredAgentId && a.id === preferredAgentId);
            const isPreferredCwd = Boolean(preferredCwd && agentCwd && isSameOrSubPath(agentCwd, preferredCwd));
            const isPreferredMatch = isPreferredAgent || isPreferredCwd;
            const tag = isPreferredMatch ? ` (${l10n.t('Target Worktree')})` : '';
            const priority =
                (isPreferredAgent ? 8 : 0) +
                (isPreferredCwd ? 6 : 0) +
                4 +
                (isMatchedCwd ? 2 : 0) +
                (isCurrentSession ? 1 : 0);
            const item: TargetQuickPickItem = {
                label: `[${sessionName}] $(hubot) ${l10n.t('Agent: {0}', a.name || a.id)}`,
                description: `${l10n.t('Session: {0} | Status: {1}', sessionName, a.status)}${tag}`,
                targetId: a.id,
                sessionName,
                isAgent: true,
                priority
            };
            allItems.push(item);

            if (isCurrentSession || isPreferredMatch) {
                primaryItems.push(item);
            } else {
                otherItems.push(item);
            }
        });
    }));

    primaryItems.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.isAgent ? 1 : 0) - (a.isAgent ? 1 : 0));
    allItems.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.isAgent ? 1 : 0) - (a.isAgent ? 1 : 0));

    let displayItems: TargetQuickPickItem[] = [];
    const hasOtherOptions = otherItems.length > 0;

    if (primaryItems.length > 0 && hasOtherOptions) {
        displayItems = [
            ...primaryItems,
            {
                label: `$(ellipsis) ` + l10n.t('Select Other Destination... (Other sessions / panes)'),
                description: l10n.t('Browse {0} more target(s) across sessions', otherItems.length),
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
            label: l10n.t('(No targets found)'),
            description: l10n.t('Run herdr in a terminal first'),
            targetId: ''
        }];
    }

    let selected = await vscode.window.showQuickPick(displayItems, {
        placeHolder: l10n.t('Select target Herdr agent or terminal'),
        title: quickPickTitle
    });

    if (!selected || !selected.targetId) return false;

    if (selected.targetId === '__SHOW_ALL__') {
        selected = await vscode.window.showQuickPick(allItems, {
            placeHolder: l10n.t('Select target across all sessions and panes'),
            title: l10n.t('{0} (All Targets)', quickPickTitle)
        });
        if (!selected || !selected.targetId) return false;
    }

    const target = selected.targetId;
    if (!target || target.startsWith('-')) {
        return false;
    }
    const sessionName = selected.sessionName;
    const sessionArgs = sessionName ? ['--session', sessionName] : [];
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!selected.isAgent || options?.stageOnly) {
        if (options?.stageOnly && socketClient.isConnected && (!sessionName || sessionName === activeSidebarSession)) {
            try {
                await socketClient.sendPaneInput(target, richText);
                const prefix = sessionName ? `[${sessionName}] ` : '';
                vscode.window.showInformationMessage(
                    selected.isAgent ? l10n.t('{0} (Agent)', successMsg) : l10n.t('{0} ({1}Pane)', successMsg, prefix)
                );
                return true;
            } catch {
                // Fallback to CLI
            }
        }
        return await new Promise<boolean>((resolve) => {
            execHerdr([...sessionArgs, 'pane', 'send-text', target, richText], { cwd }, (error) => {
                if (error) {
                    vscode.window.showErrorMessage(l10n.t('Failed to send: {0}', error.message));
                    resolve(false);
                    return;
                }
                const prefix = sessionName ? `[${sessionName}] ` : '';
                if (selected?.isAgent) {
                    vscode.window.showInformationMessage(l10n.t('{0} (Agent)', successMsg));
                } else {
                    vscode.window.showInformationMessage(l10n.t('{0} ({1}Pane)', successMsg, prefix));
                }
                resolve(true);
            });
        });
    }

    if (socketClient.isConnected && (!sessionName || sessionName === activeSidebarSession) && typeof socketClient.sendAgentPrompt === 'function') {
        try {
            await socketClient.sendAgentPrompt(target, richText);
            vscode.window.showInformationMessage(l10n.t('{0} (Agent)', successMsg));
            return true;
        } catch {
            // Fallback to CLI
        }
    }

    return await new Promise<boolean>((resolve) => {
        execHerdr([...sessionArgs, 'agent', 'prompt', target, richText], { cwd }, (error) => {
            if (error) {
                if (error.message && error.message.includes('agent_not_found')) {
                    execHerdr([...sessionArgs, 'pane', 'send-text', target, richText], { cwd }, (fbError) => {
                        if (fbError) {
                            vscode.window.showErrorMessage(l10n.t('Failed to send: {0}', fbError.message));
                            resolve(false);
                            return;
                        }
                        const prefix = sessionName ? `[${sessionName}] ` : '';
                        vscode.window.showInformationMessage(l10n.t('{0} ({1}Pane)', successMsg, prefix));
                        resolve(true);
                    });
                    return;
                }
                vscode.window.showErrorMessage(l10n.t('Failed to send context: {0}', error.message));
                resolve(false);
                return;
            }
            vscode.window.showInformationMessage(l10n.t('{0} (Agent)', successMsg));
            resolve(true);
        });
    });
}
