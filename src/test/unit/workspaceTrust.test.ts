/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import cp = require('child_process');
import {
    mockState,
    mockVscode,
    resetMockState,
    MockRange,
    MockDiagnostic,
    MockDiagnosticSeverity,
    MockUri
} from '../helpers/mockVscode';
import { isWorkspaceTrusted, ensureWorkspaceTrustedForAction } from '../../workspaceTrust';
import { ensureSessionServerRunning, execHerdr } from '../../executors';
import { reloadConfigForSessions, syncHerdrConfig, setOriginalConfigPathForTesting } from '../../configManager';
import { launchWorktreeAgentWizard, manageIntegrationsWizard } from '../../worktreeManager';
import { launchSwarmPlaybookWizard } from '../../swarmPlaybooks';
import { promptAndDispatchTask } from '../../microTaskManager';
import { AgentHUD } from '../../agentHUD';
import { WorkspaceHUD } from '../../workspaceHUD';
import { WorktreeConflictRadar } from '../../conflictRadar';
import { TerminalShellMonitor } from '../../terminalShellManager';
import { HerdrSocketClient } from '../../socketClient';

describe('Workspace Trust (Restricted Mode) Guards', () => {
    let originalExecFile: any;
    let originalSpawn: any;
    let execFileCalls: { file: string; args: string[] }[];
    let spawnCalls: { command: string; args: string[] }[];

    beforeEach(() => {
        resetMockState();
        execFileCalls = [];
        spawnCalls = [];
        originalExecFile = cp.execFile;
        originalSpawn = cp.spawn;

        (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
            execFileCalls.push({ file, args });
            const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
            if (cb) {
                cb(null, '', '');
            }
            return {} as any;
        };

        (cp as any).spawn = (command: string, args: string[], _options?: any) => {
            spawnCalls.push({ command, args });
            return {
                on: () => {},
                unref: () => {}
            } as any;
        };
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
        (cp as any).spawn = originalSpawn;
        setOriginalConfigPathForTesting(null);
    });

    describe('package.json Restricted Mode declarations', () => {
        it('marks trust-sensitive configuration keys as restricted and lists them in untrustedWorkspaces', () => {
            const pkgPath = path.resolve(__dirname, '../../../package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

            expect(pkg.capabilities?.untrustedWorkspaces?.supported).to.equal('limited');
            const restrictedList: string[] = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations || [];
            const props = pkg.contributes?.configuration?.properties || {};

            const expectedRestricted = [
                'herdr-collie.defaultAgentCommand',
                'herdr-collie.worktree.postCreateCommand',
                'herdr-collie.worktree.copyFiles',
                'herdr-collie.sessionName',
                'herdr-collie.agentHUD.autoVerifyDiagnostics'
            ];

            for (const key of expectedRestricted) {
                expect(restrictedList, `${key} should be listed in restrictedConfigurations`).to.include(key);
                expect(props[key]?.restricted, `${key} should have restricted: true`).to.equal(true);
            }
        });
    });

    describe('workspaceTrust helper', () => {
        it('returns true immediately when workspace is trusted', async () => {
            mockVscode.workspace.isTrusted = true;
            expect(isWorkspaceTrusted(mockVscode)).to.be.true;

            const allowed = await ensureWorkspaceTrustedForAction(mockVscode);
            expect(allowed).to.be.true;
            expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(0);
        });

        it('prompts via requestWorkspaceTrust when untrusted and blocks when denied or dismissed', async () => {
            mockVscode.workspace.isTrusted = false;
            expect(isWorkspaceTrusted(mockVscode)).to.be.false;

            mockState.workspaceTrustRequestResponse = false;
            expect(await ensureWorkspaceTrustedForAction(mockVscode)).to.be.false;
            expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(1);
            expect(mockVscode.workspace.isTrusted).to.be.false;

            mockState.workspaceTrustRequestResponse = undefined;
            expect(await ensureWorkspaceTrustedForAction(mockVscode)).to.be.false;
            expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(2);
        });

        it('grants access and flips isTrusted when user approves requestWorkspaceTrust', async () => {
            mockVscode.workspace.isTrusted = false;
            mockState.workspaceTrustRequestResponse = true;

            const allowed = await ensureWorkspaceTrustedForAction(mockVscode);
            expect(allowed).to.be.true;
            expect(mockVscode.workspace.isTrusted).to.be.true;
            expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(1);
        });

        it('falls back to warning message when requestWorkspaceTrust API is unavailable', async () => {
            const legacyVscode = {
                workspace: { isTrusted: false },
                window: mockVscode.window
            };

            const allowed = await ensureWorkspaceTrustedForAction(legacyVscode);
            expect(allowed).to.be.false;
            expect(mockState.lastWarningMessage?.message).to.include('Restricted Mode');
        });
    });

    describe('Automatic & background execution guards in Restricted Mode', () => {
        it('does not spawn herdr server in ensureSessionServerRunning or execHerdr retry when untrusted', async () => {
            mockVscode.workspace.isTrusted = false;

            const started = await ensureSessionServerRunning('vscode');
            expect(started).to.be.false;
            expect(spawnCalls).to.be.empty;

            (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
                execFileCalls.push({ file, args });
                const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
                if (cb) {
                    cb(new Error('server_not_running'), '', 'server_not_running');
                }
                return {} as any;
            };

            await new Promise<void>((resolve) => {
                execHerdr(['workspace', 'list'], () => resolve());
            });
            expect(execFileCalls).to.have.lengthOf(1);
            expect(spawnCalls).to.be.empty;
        });

        it('skips reloadConfigForSessions CLI execution in configManager when untrusted', async () => {
            mockVscode.workspace.isTrusted = false;
            const tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-trust-cfg-'));
            try {
                setOriginalConfigPathForTesting(path.join(tempStorageDir, 'missing.toml'));
                reloadConfigForSessions('vscode', mockVscode);
                expect(execFileCalls).to.be.empty;

                await syncHerdrConfig(
                    { globalStorageUri: { fsPath: tempStorageDir }, subscriptions: [] },
                    true,
                    'vscode',
                    mockVscode
                );
                expect(execFileCalls).to.be.empty;
            } finally {
                fs.rmSync(tempStorageDir, { recursive: true, force: true });
            }
        });

        it('skips CLI fallback in AgentHUD and WorkspaceHUD when untrusted', async () => {
            mockVscode.workspace.isTrusted = false;
            const fakeSocket = {
                isConnected: false,
                on: () => fakeSocket,
                off: () => fakeSocket
            } as unknown as HerdrSocketClient;

            const agentHUD = new AgentHUD(fakeSocket, () => 'vscode');
            const workspaceHUD = new WorkspaceHUD(fakeSocket, () => 'vscode', async () => []);

            try {
                await agentHUD.refresh();
                await workspaceHUD.refresh();
                expect(execFileCalls).to.be.empty;
            } finally {
                agentHUD.dispose();
                workspaceHUD.dispose();
            }
        });

        it('disables autoVerifyDiagnostics auto mode in AgentHUD when untrusted', async () => {
            mockVscode.workspace.isTrusted = false;
            mockState.configurations.set('herdr-collie.agentHUD.autoVerifyDiagnostics', 'auto');
            mockState.configurations.set('herdr-collie.agentHUD.enableNotifications', false);
            mockState.workspaceDiagnostics = [
                [new MockUri('/repo/src/app.ts'), [new MockDiagnostic(new MockRange(0, 0), 'Type error', MockDiagnosticSeverity.Error)]]
            ];

            let currentAgents = [
                { id: 'pane-1', name: 'claude', status: 'working', statusType: 'working', statusIcon: '🟢', isWorking: true, isBlocked: false }
            ];
            let socketPromptSent = false;
            const fakeSocket = {
                isConnected: true,
                on: () => fakeSocket,
                off: () => fakeSocket,
                getSnapshot: async () => ({
                    agents: currentAgents
                }),
                sendAgentPrompt: async () => {
                    socketPromptSent = true;
                }
            } as unknown as HerdrSocketClient;

            const agentHUD = new AgentHUD(fakeSocket, () => 'vscode');
            try {
                await agentHUD.refresh();
                currentAgents = [
                    { id: 'pane-1', name: 'claude', status: 'done', statusType: 'done', statusIcon: '✅', isWorking: false, isBlocked: false }
                ];
                await agentHUD.refresh();
                expect(socketPromptSent).to.be.false;
                expect(execFileCalls).to.be.empty;
                expect(agentHUD.getAutoVerifyRetryCount('pane-1')).to.equal(0);
            } finally {
                agentHUD.dispose();
            }
        });

        it('skips Git scanning in WorktreeConflictRadar when untrusted and prompts on wizard', async () => {
            mockVscode.workspace.isTrusted = false;
            let repoRootCalled = false;

            const radar = new WorktreeConflictRadar({
                getRepoRoot: async () => {
                    repoRootCalled = true;
                    return '/repo';
                },
                getActiveAgents: () => [],
                dispatchPrompt: async () => true
            });

            try {
                const res = await radar.scanNow(true);
                expect(res).to.be.null;
                expect(repoRootCalled).to.be.false;

                mockState.workspaceTrustRequestResponse = false;
                await radar.showConflictRadarWizard();
                expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(1);
                expect(repoRootCalled).to.be.false;
            } finally {
                radar.dispose();
            }
        });
    });

    describe('User-initiated wizard & command guards in Restricted Mode', () => {
        it('blocks launchWorktreeAgentWizard, launchSwarmPlaybookWizard, manageIntegrationsWizard, promptAndDispatchTask, and terminalShellMonitor when trust is denied', async () => {
            mockVscode.workspace.isTrusted = false;
            mockState.workspaceTrustRequestResponse = false;
            (mockVscode.workspace as any).workspaceFolders = [{ uri: new MockUri('/repo') }];

            try {
                await launchWorktreeAgentWizard('vscode');
                await launchSwarmPlaybookWizard('vscode');
                await manageIntegrationsWizard();
                const dispatched = await promptAndDispatchTask('Fix bug', 'Fix Bug');
                expect(dispatched).to.be.false;

                const monitor = new TerminalShellMonitor(async () => true);
                try {
                    await monitor.fixFailedExecutionWizard();
                } finally {
                    monitor.dispose();
                }

                expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(5);
                expect(execFileCalls).to.be.empty;
                expect(spawnCalls).to.be.empty;
            } finally {
                delete (mockVscode.workspace as any).workspaceFolders;
            }
        });

        it('proceeds after user grants trust via requestWorkspaceTrust in launchWorktreeAgentWizard', async () => {
            mockVscode.workspace.isTrusted = false;
            mockState.workspaceTrustRequestResponse = true;
            // No workspace folders -> proceeds past trust check and reports missing folder
            delete (mockVscode.workspace as any).workspaceFolders;

            let errorMsg = '';
            const origShowErr = (mockVscode.window as any).showErrorMessage;
            (mockVscode.window as any).showErrorMessage = async (msg: string) => {
                errorMsg = msg;
                return undefined;
            };

            try {
                await launchWorktreeAgentWizard('vscode');
                expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(1);
                expect(mockVscode.workspace.isTrusted).to.be.true;
                expect(errorMsg).to.include('Please open a folder');
            } finally {
                (mockVscode.window as any).showErrorMessage = origShowErr;
            }
        });
    });
});
