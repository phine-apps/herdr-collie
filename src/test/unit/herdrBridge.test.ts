/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { expect } from 'chai';
import cp = require('child_process');
import { mockState, mockVscode, resetMockState } from '../helpers/mockVscode';
import { createTerminalBridge, createSessionSwitchCoordinator, fetchRunningSessions, getSessionName, sendPromptToHerdr } from '../../herdrBridge';
import { HerdrSocketClient } from '../../socketClient';

describe('herdrBridge Unit Tests', () => {
    let originalExecFile: any;
    let originalTerminalsDescriptor: PropertyDescriptor | undefined;
    let originalCreateTerminal: any;
    let originalOnDidOpenTerminal: any;
    let originalOnDidCloseTerminal: any;
    let execFileCalls: string[][];

    beforeEach(() => {
        resetMockState();
        execFileCalls = [];
        originalExecFile = cp.execFile;
        originalTerminalsDescriptor = Object.getOwnPropertyDescriptor(mockVscode.window, 'terminals');
        originalCreateTerminal = (mockVscode.window as any).createTerminal;
        originalOnDidOpenTerminal = (mockVscode.window as any).onDidOpenTerminal;
        originalOnDidCloseTerminal = (mockVscode.window as any).onDidCloseTerminal;

        (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
            execFileCalls.push(args);
            const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
            if (cb) {
                if (args[0] === 'session' && args[1] === 'list') {
                    cb(null, JSON.stringify({ sessions: [{ name: 'vscode', default: false, running: true }] }), '');
                } else {
                    cb(null, '{}', '');
                }
            }
            return {} as any;
        };
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
        if (originalTerminalsDescriptor) {
            Object.defineProperty(mockVscode.window, 'terminals', originalTerminalsDescriptor);
        } else {
            delete (mockVscode.window as any).terminals;
        }
        if (originalCreateTerminal !== undefined) {
            (mockVscode.window as any).createTerminal = originalCreateTerminal;
        } else {
            delete (mockVscode.window as any).createTerminal;
        }
        if (originalOnDidOpenTerminal !== undefined) {
            (mockVscode.window as any).onDidOpenTerminal = originalOnDidOpenTerminal;
        } else {
            delete (mockVscode.window as any).onDidOpenTerminal;
        }
        if (originalOnDidCloseTerminal !== undefined) {
            (mockVscode.window as any).onDidCloseTerminal = originalOnDidCloseTerminal;
        } else {
            delete (mockVscode.window as any).onDidCloseTerminal;
        }
    });

    it('cancels pending restore timers when TerminalBridge is disposed', async () => {
        const sentTexts: string[] = [];
        const mockTerminal: any = {
            name: 'Herdr (vscode)',
            exitStatus: undefined,
            processId: Promise.resolve(undefined), // undefined skips pgrep / ps check (returns false)
            sendText: (text: string) => sentTexts.push(text),
            show: () => {},
            dispose: () => {}
        };
        (mockVscode.window as any).terminals = [mockTerminal];

        // Stub which/where to report herdr exists without spawning
        (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
            execFileCalls.push([file, ...args]);
            const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
            if (cb) {
                if (args[0] === '--session') {
                    cb(null, 'ok', '');
                } else {
                    cb(null, '/usr/local/bin/herdr', '');
                }
            }
            return {} as any;
        };

        const bridge = createTerminalBridge(() => {}, {
            ensureServerRunning: async () => true
        });
        await bridge.restoreTerminalIfNeeded('vscode', mockTerminal);
        bridge.dispose();

        // Wait longer than the initial 600ms timer to confirm it was cancelled
        await new Promise(resolve => setTimeout(resolve, 700));
        expect(sentTexts).to.be.empty;
    });

    it('cancels pending restore timer when openOrAttachTerminal manually sends command within 600ms', async () => {
        const sentTexts: string[] = [];
        const mockTerminal: any = {
            name: 'Herdr (vscode)',
            exitStatus: undefined,
            processId: Promise.resolve(undefined),
            sendText: (text: string) => sentTexts.push(text),
            show: () => {},
            dispose: () => {}
        };
        (mockVscode.window as any).terminals = [mockTerminal];
        (cp as any).execFile = (file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            callback?.(null, '/usr/local/bin/herdr', '');
            return {} as any;
        };

        const bridge = createTerminalBridge(() => {}, {
            ensureServerRunning: async () => true
        });
        try {
            await bridge.restoreTerminalIfNeeded('vscode', mockTerminal);
            await bridge.openOrAttachTerminal('w1', false, 'App', 'vscode');
            await new Promise(resolve => setTimeout(resolve, 750));
            expect(sentTexts).to.deep.equal(['herdr --session vscode']);
        } finally {
            bridge.dispose();
        }
    });

    it('does not collide default "Herdr" terminal with "vscode" session in openOrAttachTerminal', async () => {
        const defaultTerminalCalls: string[] = [];
        const createdTerminals: Array<{ name: string; sent: string[] }> = [];

        const defaultTerminal: any = {
            name: 'Herdr',
            exitStatus: undefined,
            processId: Promise.resolve(undefined),
            sendText: (text: string) => defaultTerminalCalls.push(text),
            show: () => {},
            dispose: () => {}
        };
        (mockVscode.window as any).terminals = [defaultTerminal];
        (mockVscode.window as any).createTerminal = (opts: { name: string }) => {
            const rec = { name: opts.name, sent: [] as string[] };
            createdTerminals.push(rec);
            return {
                name: opts.name,
                exitStatus: undefined,
                processId: Promise.resolve(undefined),
                sendText: (text: string) => rec.sent.push(text),
                show: () => {},
                dispose: () => {}
            };
        };

        const startedSessions: Array<string | undefined> = [];
        const bridge = createTerminalBridge(() => {}, {
            ensureServerRunning: async (session) => {
                startedSessions.push(session);
                return true;
            }
        });
        try {
            await bridge.openOrAttachTerminal('', false, 'vscode', 'vscode');
            expect(defaultTerminalCalls).to.be.empty;
            expect(createdTerminals).to.have.lengthOf(1);
            expect(createdTerminals[0].name).to.equal('Herdr (vscode)');
            expect(createdTerminals[0].sent).to.deep.equal(['herdr --session vscode']);

            await bridge.openOrAttachTerminal('ws-1', false, 'malicious', '--evil');
            expect(createdTerminals).to.have.lengthOf(2);
            expect(createdTerminals[1].name).to.equal('Herdr (evil)');
            expect(createdTerminals[1].sent).to.deep.equal(['herdr --session evil']);
            expect(startedSessions).to.deep.equal(['vscode', 'evil']);
            expect(execFileCalls).to.deep.include(['--session', 'evil', 'workspace', 'focus', 'ws-1']);
        } finally {
            bridge.dispose();
        }
    });

    it('sanitizes session extracted from restored terminal name consistently across server start and sendText', async () => {
        const sentTexts: string[] = [];
        const startedSessions: Array<string | undefined> = [];
        const mockTerminal: any = {
            name: 'Herdr (--bad;name)',
            exitStatus: undefined,
            processId: Promise.resolve(undefined),
            sendText: (text: string) => sentTexts.push(text),
            show: () => {},
            dispose: () => {}
        };
        (mockVscode.window as any).terminals = [mockTerminal];

        const bridge = createTerminalBridge(() => {}, {
            ensureServerRunning: async (session) => {
                startedSessions.push(session);
                return true;
            }
        });
        try {
            await bridge.restoreTerminalIfNeeded('vscode', mockTerminal);
            await new Promise(resolve => setTimeout(resolve, 650));
            expect(startedSessions).to.deep.equal(['badname']);
            expect(sentTexts).to.deep.equal(['herdr --session badname']);
        } finally {
            bridge.dispose();
        }
    });

    it('uses socketClient.getSnapshot() for active session in sendPromptToHerdr without spawning workspace/pane/agent CLI calls', async () => {
        mockState.configurations.set('herdr-collie.sessionName', 'vscode');

        let snapshotCalls = 0;
        const fakeSocket = {
            isConnected: true,
            getSnapshot: async () => {
                snapshotCalls++;
                return {
                    workspaces: [{ workspace_id: 'w1', label: 'herdr-collie', cwd: '/repo/herdr-collie' }],
                    panes: [{ pane_id: 'w1:p1', name: 'claude', workspace_id: 'w1', foreground_cwd: '/repo/herdr-collie', command: 'claude' }],
                    agents: [{ pane_id: 'w1:p1', name: 'claude', agent_status: 'idle', workspace_id: 'w1' }]
                };
            }
        } as unknown as HerdrSocketClient;

        const ok = await sendPromptToHerdr({
            activeSidebarSession: 'vscode',
            socketClient: fakeSocket,
            richText: 'Check tests',
            successMsg: 'Sent!',
            quickPickTitle: 'Send Prompt'
        });

        expect(ok).to.be.true;
        expect(snapshotCalls).to.equal(1);

        // Discovery CLI calls (workspace/pane/agent list) must NOT be spawned for active socket-connected session
        const discoveryCalls = execFileCalls.filter(
            args => args[0] === '--session' && ['workspace', 'pane', 'agent'].includes(args[2]) && args[3] === 'list'
        );
        expect(discoveryCalls).to.be.empty;
        expect(execFileCalls).to.deep.include(['--session', 'vscode', 'agent', 'prompt', 'w1:p1', 'Check tests']);
    });

    it('invalidates stale session switch generations in createSessionSwitchCoordinator', async () => {
        const coordinator = createSessionSwitchCoordinator();

        const results: string[] = [];
        const runSwitch = async (session: string, delayMs: number) => {
            const token = coordinator.begin();
            await new Promise(resolve => setTimeout(resolve, delayMs));
            if (coordinator.isLatest(token)) {
                results.push(session);
            }
        };

        await Promise.all([
            runSwitch('older-slow', 40),
            (async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                await runSwitch('newer-fast', 5);
            })()
        ]);

        expect(results).to.deep.equal(['newer-fast']);

        const pendingToken = coordinator.begin();
        coordinator.invalidate();
        expect(coordinator.isLatest(pendingToken)).to.be.false;
    });

    it('resets pending target safely in runSwitch when task throws and prevents stale failure from clearing newer switch', async () => {
        const coordinator = createSessionSwitchCoordinator();

        let threw = false;
        try {
            await coordinator.runSwitch('failing-session', async () => {
                expect(coordinator.getPendingTarget()).to.equal('failing-session');
                throw new Error('server start error');
            });
        } catch {
            threw = true;
        }
        expect(threw).to.be.true;
        expect(coordinator.getPendingTarget()).to.be.null;

        // Overlap: slow failing switch must not clear newer active pending target
        const slowSwitch = coordinator.runSwitch('slow-old', async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            throw new Error('slow fail');
        }).catch(() => false);

        await new Promise(resolve => setTimeout(resolve, 10));
        const fastSwitch = coordinator.runSwitch('fast-new', async (isLatest) => {
            expect(coordinator.getPendingTarget()).to.equal('fast-new');
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(isLatest()).to.be.true;
        });

        await slowSwitch;
        // fast-new is still running when slow-old finishes/rejects
        expect(coordinator.getPendingTarget()).to.equal('fast-new');
        expect(await fastSwitch).to.be.true;
        expect(coordinator.getPendingTarget()).to.be.null;
    });

    it('falls back to "vscode" in getSessionName() when configured sessionName is unsafe or invalid', () => {
        mockState.configurations.set('herdr-collie.sessionName', '--evil');
        expect(getSessionName()).to.equal('vscode');

        mockState.configurations.set('herdr-collie.sessionName', 'bad;session');
        expect(getSessionName()).to.equal('vscode');

        mockState.configurations.set('herdr-collie.sessionName', '  team_alpha-1  ');
        expect(getSessionName()).to.equal('team_alpha-1');
    });

    it('coalesces concurrent openOrAttachTerminal calls and rejects unsafe CLI targets', async () => {
        let createTerminalCalls = 0;
        const createdTerminals: any[] = [];
        (mockVscode.window as any).createTerminal = (opts: any) => {
            createTerminalCalls++;
            const term: any = {
                name: opts.name,
                exitStatus: undefined,
                processId: Promise.resolve(undefined),
                sendText: () => {},
                show: () => {},
                dispose: () => {}
            };
            createdTerminals.push(term);
            return term;
        };
        Object.defineProperty(mockVscode.window, 'terminals', {
            configurable: true,
            get: () => createdTerminals
        });
        (mockVscode.window as any).onDidOpenTerminal = () => ({ dispose: () => {} });
        (mockVscode.window as any).onDidCloseTerminal = () => ({ dispose: () => {} });

        (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            execFileCalls.push(args);
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (callback) {
                setTimeout(() => callback(null, '', ''), 20);
            }
            return {} as any;
        };

        const bridge = createTerminalBridge(
            () => {},
            { ensureServerRunning: async () => true }
        );
        try {
            // Reject unsafe target / unsafe tabId / unsafe workspaceId before issuing CLI commands or terminals
            await bridge.openOrAttachTerminal('-evil-id', false, 'Bad', 'vscode');
            await bridge.openOrAttachTerminal('w1', false, 'BadTab', 'vscode', 'w1', '--evil-tab');
            await bridge.openOrAttachTerminal('w1:p1', true, 'BadWs', 'vscode', '-evil-ws');
            expect(execFileCalls).to.be.empty;
            expect(createTerminalCalls).to.equal(0);

            // Concurrent calls for the same session serialize cleanly, create a single terminal, and still honor the latest target focus
            await Promise.all([
                bridge.openOrAttachTerminal('w1', false, 'App 1', 'vscode'),
                bridge.openOrAttachTerminal('w2', false, 'App 2', 'vscode')
            ]);
            expect(createTerminalCalls).to.equal(1);
            expect(execFileCalls.some(a => a.includes('focus') && a.includes('w2'))).to.be.true;
        } finally {
            bridge.dispose();
        }
    });

    it('filters stopped sessions in fetchRunningSessions and skips auto-start on sendPromptToHerdr CLI discovery', async () => {
        const origSpawn = cp.spawn;
        let spawnCalls = 0;
        (cp as any).spawn = () => {
            spawnCalls++;
            return { unref: () => {}, on: () => {} } as any;
        };

        let quickPickItems: any[] = [];
        const origShowQuickPick = mockVscode.window.showQuickPick;
        (mockVscode.window as any).showQuickPick = async (items: any[]) => {
            quickPickItems = items;
            return undefined;
        };

        (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            execFileCalls.push(args);
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (args[0] === 'session' && args[1] === 'list') {
                callback?.(null, JSON.stringify({
                    sessions: [
                        { name: 'default', default: true, running: false },
                        { name: 'vscode', default: false, running: true }
                    ]
                }), '');
                return {} as any;
            }
            if (args[0] === '--session' && args[1] === 'vscode' && args[2] === 'workspace' && args[3] === 'list') {
                callback?.(null, JSON.stringify({ workspaces: [{ workspace_id: 'w1', label: 'repo' }] }), '');
                return {} as any;
            }
            if (args[0] === '--session' && args[1] === 'vscode' && args[2] === 'pane' && args[3] === 'list') {
                callback?.(null, JSON.stringify({ panes: [{ pane_id: 'w1:p1', name: 'main', workspace_id: 'w1', foreground_cwd: '/tmp/repo' }] }), '');
                return {} as any;
            }
            if (args[0] === '--session' && args[1] === 'vscode' && args[2] === 'agent' && args[3] === 'list') {
                callback?.(null, JSON.stringify({ agents: [{ pane_id: 'w1:p1', name: 'claude', status: 'idle', workspace_id: 'w1' }] }), '');
                return {} as any;
            }
            callback?.(new Error('server_not_running'), '', 'error: server_not_running');
            return {} as any;
        };

        const disconnectedSocket = {
            isConnected: false,
            getSnapshot: async () => null
        } as unknown as HerdrSocketClient;

        try {
            const running = await fetchRunningSessions();
            expect(running).to.deep.equal(['vscode']);

            await sendPromptToHerdr({
                activeSidebarSession: 'default',
                socketClient: disconnectedSocket,
                richText: 'Review changes',
                successMsg: 'Sent',
                quickPickTitle: 'Send Prompt'
            });

            expect(execFileCalls.some(a => a[0] === '--session' && a[1] === 'default')).to.be.false;
            expect(spawnCalls).to.equal(0);
            expect(quickPickItems.some(item => item.targetId === 'w1:p1')).to.be.true;
        } finally {
            cp.spawn = origSpawn;
            (mockVscode.window as any).showQuickPick = origShowQuickPick;
        }
    });
});
