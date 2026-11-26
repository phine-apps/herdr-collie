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
import { mockState, mockVscode, resetMockState, MockUri } from '../helpers/mockVscode';
import { registerWorktreeCommands } from '../../commands/worktreeCommands';
import { registerContextCommands } from '../../commands/contextCommands';
import { registerReviewCommands } from '../../commands/reviewCommands';
import { registerSessionCommands } from '../../commands/sessionCommands';
import { CommandContext } from '../../commands/types';
import { createWorktree, resolveWorktreePath, listGitWorktrees } from '../../worktreeManager';
import { HerdrReviewController, HerdrReviewChangesProvider, getDiffCacheDir } from '../../reviewManager';
import { resolveMainRepositoryRoot } from '../../gitContext';
import { runGitCmd } from '../../executors';

describe('Command Handler Unit & Multi-Root Tests', () => {
    let originalRegisterCommand: any;
    let originalExecFile: any;
    let registeredHandlers: Map<string, (...args: any[]) => any>;
    let tempDirs: string[];

    beforeEach(() => {
        resetMockState();
        registeredHandlers = new Map();
        tempDirs = [];
        originalRegisterCommand = (mockVscode.commands as any).registerCommand;
        originalExecFile = cp.execFile;

        (mockVscode.commands as any).registerCommand = (commandId: string, handler: (...args: any[]) => any) => {
            registeredHandlers.set(commandId, handler);
            return { dispose: () => registeredHandlers.delete(commandId) };
        };
    });

    afterEach(() => {
        if (originalRegisterCommand !== undefined) {
            (mockVscode.commands as any).registerCommand = originalRegisterCommand;
        } else {
            delete (mockVscode.commands as any).registerCommand;
        }
        (cp as any).execFile = originalExecFile;
        delete (mockVscode.workspace as any).workspaceFolders;
        delete (mockVscode.window as any).activeTextEditor;
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    const createTempGitRepo = async (defaultBranch: string = 'main'): Promise<string> => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-cmd-repo-'));
        tempDirs.push(repoDir);
        await runGitCmd(['init', '-b', defaultBranch], repoDir);
        await runGitCmd(['config', 'user.email', 'test@example.com'], repoDir);
        await runGitCmd(['config', 'user.name', 'Test User'], repoDir);
        fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo\n', 'utf8');
        await runGitCmd(['add', 'README.md'], repoDir);
        await runGitCmd(['commit', '-m', 'Initial commit'], repoDir);
        return fs.realpathSync(repoDir);
    };

    const createMockCommandContext = (overrides?: Partial<CommandContext>): CommandContext => ({
        getActiveSidebarSession: () => 'vscode',
        getSocketClient: () => ({ isConnected: false } as any),
        refreshAllProviders: () => {},
        updateTreeViewDescriptions: () => {},
        openOrAttachTerminal: async () => {},
        sendToHerdr: async () => true,
        switchToSession: async () => {},
        performDeleteSession: async () => {},
        getActiveRepoRoot: async () => null,
        resolveMainRepoRoot: (hintPath?: string) => resolveMainRepositoryRoot(hintPath),
        loadWorktreeScorecards: async () => new Map(),
        activateWorktreeReviewTarget: async () => {},
        getAgentItems: () => [],
        sessionProvider: {} as any,
        agentProvider: {} as any,
        agentHUD: {} as any,
        reviewController: {} as any,
        reviewChangesProvider: {} as any,
        terminalShellMonitor: {} as any,
        getConflictRadar: () => undefined,
        ...overrides
    });

    it('herdr-collie.removeWorktree awaits herdr workspace close before removing linked worktree via main repo root', async () => {
        const mainRepoDir = await createTempGitRepo('main');
        const wtPath = resolveWorktreePath(mainRepoDir, 'feat/remove-order', 'sibling');
        tempDirs.push(wtPath);
        await createWorktree(mainRepoDir, 'feat/remove-order', wtPath, 'main');

        const events: string[] = [];
        const realExecFile = cp.execFile;
        (cp as any).execFile = (file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            const options = typeof optionsOrCb === 'object' ? optionsOrCb : {};
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (file === 'herdr' && args.includes('close')) {
                setTimeout(() => {
                    events.push('herdr:workspace:close');
                    callback?.(null, '', '');
                }, 40);
                return {} as any;
            }
            if (file === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
                events.push(`git:worktree:remove:${options.cwd}`);
            }
            return (realExecFile as any)(file, args, optionsOrCb, cb);
        };

        let refreshed = false;
        const fakeContext = { subscriptions: [] } as any;
        registerWorktreeCommands(fakeContext, createMockCommandContext({
            refreshAllProviders: () => { refreshed = true; }
        }));

        mockState.warningMessageResponse = 'Remove Worktree';
        const handler = registeredHandlers.get('herdr-collie.removeWorktree')!;
        await handler({
            cwd: wtPath,
            rawId: 'ws-linked',
            label: 'feat/remove-order'
        });

        expect(events).to.deep.equal([
            'herdr:workspace:close',
            `git:worktree:remove:${mainRepoDir}`
        ]);
        expect(refreshed).to.be.true;
        const remaining = await listGitWorktrees(mainRepoDir);
        expect(remaining.some(w => w.worktree === wtPath)).to.be.false;
    });

    it('herdr-collie.mergeWorktree resolves main repo from item.cwd even in multi-root workspaces', async () => {
        const firstRoot = await createTempGitRepo('main');
        const secondRoot = await createTempGitRepo('main');
        const wtPath = resolveWorktreePath(secondRoot, 'feat/multi-root', 'sibling');
        tempDirs.push(wtPath);
        await createWorktree(secondRoot, 'feat/multi-root', wtPath, 'main');
        fs.writeFileSync(path.join(wtPath, 'second.txt'), 'from second root\n', 'utf8');
        await runGitCmd(['add', 'second.txt'], wtPath);
        await runGitCmd(['commit', '-m', 'Add second.txt'], wtPath);

        (mockVscode.workspace as any).workspaceFolders = [
            { uri: MockUri.file(firstRoot) },
            { uri: MockUri.file(secondRoot) }
        ];

        const fakeContext = { subscriptions: [] } as any;

        // Approve merge confirmation so mergeWorktree executes against secondRoot
        mockState.informationMessageResponse = 'Merge Branch';
        let mergeResolvedHint: string | undefined;
        registerWorktreeCommands(fakeContext, createMockCommandContext({
            resolveMainRepoRoot: async (hint?: string) => {
                mergeResolvedHint = hint;
                return resolveMainRepositoryRoot(hint);
            }
        }));

        const handler = registeredHandlers.get('herdr-collie.mergeWorktree')!;
        await handler({
            cwd: wtPath,
            branchName: 'feat/multi-root',
            label: 'feat/multi-root'
        });

        expect(mergeResolvedHint).to.equal(wtPath);
        expect(fs.existsSync(path.join(secondRoot, 'second.txt'))).to.be.true;
        expect(fs.existsSync(path.join(firstRoot, 'second.txt'))).to.be.false;
    });

    it('herdr-collie.sendBranchContext succeeds on repositories using non-standard default branch names (trunk)', async () => {
        const trunkRepo = await createTempGitRepo('trunk');
        (mockVscode.workspace as any).workspaceFolders = [{ uri: MockUri.file(trunkRepo) }];

        const sentPrompts: Array<{ richText: string; title: string }> = [];
        const fakeContext = { subscriptions: [] } as any;
        registerContextCommands(fakeContext, createMockCommandContext({
            sendToHerdr: async (richText, _successMsg, title) => {
                sentPrompts.push({ richText, title });
                return true;
            }
        }));

        const handler = registeredHandlers.get('herdr-collie.sendBranchContext')!;
        await handler();

        expect(sentPrompts).to.have.lengthOf(1);
        expect(sentPrompts[0].richText).to.include('trunk');
        expect(sentPrompts[0].richText).to.include('Initial commit');
    });

    it('herdr-collie.sendStagedChanges and sendWorkingTreeChanges scope diff to file when invoked from editor/context with a Uri', async () => {
        const repoDir = await createTempGitRepo('main');
        const fileA = path.join(repoDir, 'a.ts');
        const fileB = path.join(repoDir, 'b.ts');
        fs.writeFileSync(fileA, 'export const a = 1;\n', 'utf8');
        fs.writeFileSync(fileB, 'export const b = 1;\n', 'utf8');
        await runGitCmd(['add', 'a.ts', 'b.ts'], repoDir);
        await runGitCmd(['commit', '-m', 'Add a and b'], repoDir);

        // Stage change in a.ts and working change in b.ts + a.ts
        fs.writeFileSync(fileA, 'export const a = 2;\n', 'utf8');
        await runGitCmd(['add', 'a.ts'], repoDir);
        fs.writeFileSync(fileA, 'export const a = 3;\n', 'utf8');
        fs.writeFileSync(fileB, 'export const b = 2;\n', 'utf8');

        const sentPrompts: string[] = [];
        const fakeContext = { subscriptions: [] } as any;
        registerContextCommands(fakeContext, createMockCommandContext({
            sendToHerdr: async (richText) => {
                sentPrompts.push(richText);
                return true;
            }
        }));

        await registeredHandlers.get('herdr-collie.sendStagedChanges')!(MockUri.file(fileA));
        await registeredHandlers.get('herdr-collie.sendWorkingTreeChanges')!(MockUri.file(fileB));

        expect(sentPrompts).to.have.lengthOf(2);
        expect(sentPrompts[0]).to.include('a.ts');
        expect(sentPrompts[0]).to.not.include('b.ts');
        expect(sentPrompts[1]).to.include('b.ts');
        expect(sentPrompts[1]).to.not.include('a.ts');
    });

    it('herdr-collie.submitReview does not advance baseCheckpoint when target QuickPick is cancelled, and openDiff respects Restricted Mode', async () => {
        const repoDir = await createTempGitRepo('main');
        fs.writeFileSync(path.join(repoDir, 'file.ts'), 'export const x = 1;\n', 'utf8');

        const controller = new HerdrReviewController();
        const changesProvider = new HerdrReviewChangesProvider(async () => repoDir, 'flat');
        try {
            controller.addCommentFromEditor(MockUri.file(path.join(repoDir, 'file.ts')) as any, 1, 1, 'Fix x', 'export const x = 1;', repoDir);
            expect(changesProvider.getBaseCheckpoint()).to.be.null;

            const fakeContext = { subscriptions: [] } as any;
            registerReviewCommands(fakeContext, createMockCommandContext({
                reviewController: controller,
                reviewChangesProvider: changesProvider,
                resolveMainRepoRoot: async () => repoDir,
                sendToHerdr: async () => false // User cancelled agent selection QuickPick
            }));

            // First QuickPick item from mockVscode is Standard Review
            await registeredHandlers.get('herdr-collie.submitReview')!();

            // Comments preserved and baseCheckpoint NOT created/advanced on cancel
            expect(controller.commentCount).to.equal(1);
            expect(changesProvider.getBaseCheckpoint()).to.be.null;

            // openDiff must guard Restricted Mode
            mockVscode.workspace.isTrusted = false;
            mockState.workspaceTrustRequestResponse = false;
            await registeredHandlers.get('herdr-collie.openDiff')!({
                isFolder: false,
                repoRoot: repoDir,
                change: { filePath: 'file.ts', fileName: 'file.ts', status: 'M' }
            });
            expect(mockState.requestWorkspaceTrustCalls).to.have.lengthOf(1);
            expect(mockState.executedCommands).to.be.empty;
        } finally {
            controller.dispose();
            changesProvider.dispose();
        }
    });

    it('herdr-collie.renameWorkspace rejects leading-hyphen workspace IDs and switchSession handles createQuickPick.onDidHide cleanly', async () => {
        const execCalls: string[][] = [];
        (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            execCalls.push(args);
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (callback) {
                callback(null, JSON.stringify({ sessions: [{ name: 'vscode', default: false, running: true }] }), '');
            }
            return {} as any;
        };

        const fakeContext = { subscriptions: [] } as any;
        registerSessionCommands(fakeContext, createMockCommandContext());

        mockState.inputBoxResponse = 'New Label';
        await registeredHandlers.get('herdr-collie.renameWorkspace')!({
            rawId: '-malicious-id',
            label: 'Old'
        });
        expect(execCalls).to.be.empty;

        // Exercise switchSession QuickPick path (requires createQuickPick.onDidHide in mockVscode)
        await registeredHandlers.get('herdr-collie.switchSession')!();
        expect(execCalls.some(a => a[0] === 'session' && a[1] === 'list')).to.be.true;
    });

    it('rejects invalid session names in switchSessionDirect, unsafe target IDs in tree commands, and baseline diff-cache files in addReviewComment', async () => {
        const execCalls: string[][] = [];
        const switchedSessions: string[] = [];
        (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            execCalls.push(args);
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            callback?.(null, '', '');
            return {} as any;
        };

        const controller = new HerdrReviewController();
        const changesProvider = new HerdrReviewChangesProvider(async () => null, 'flat');
        const fakeContext = { subscriptions: [] } as any;
        try {
            registerSessionCommands(fakeContext, createMockCommandContext({
                switchToSession: async (s: string) => { switchedSessions.push(s); }
            }));
            registerReviewCommands(fakeContext, createMockCommandContext({
                reviewController: controller,
                reviewChangesProvider: changesProvider
            }));

            // switchSessionDirect must reject path traversal / flag injection
            await registeredHandlers.get('herdr-collie.switchSessionDirect')!('../evil');
            await registeredHandlers.get('herdr-collie.switchSessionDirect')!('--flag');
            expect(switchedSessions).to.be.empty;
            expect(mockState.lastWarningMessage?.message).to.include('Invalid session name');

            // Tree commands must reject leading-hyphen target IDs before invoking execHerdr
            await registeredHandlers.get('herdr-collie.closeWorkspace')!({ rawId: '-bad-ws' });
            await registeredHandlers.get('herdr-collie.closeTab')!({ tabId: '-bad-tab' });
            await registeredHandlers.get('herdr-collie.peekAgentOutput')!({ rawId: '-bad-agent' });
            expect(execCalls).to.be.empty;

            // addReviewComment must warn and abort for temporary diff-cache baseline URIs
            const baselineUri = MockUri.file(path.join(getDiffCacheDir(), 'head-baseline.ts'));
            await registeredHandlers.get('herdr-collie.addReviewComment')!(baselineUri);
            expect(mockState.lastWarningMessage?.message).to.include('temporary baseline file');
            expect(controller.commentCount).to.equal(0);
        } finally {
            controller.dispose();
            changesProvider.dispose();
        }
    });
});
