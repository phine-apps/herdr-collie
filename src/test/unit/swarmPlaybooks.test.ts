/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { resetMockState } from '../helpers/mockVscode';
import { expect } from 'chai';
import * as path from 'path';
import cp = require('child_process');
import {
    buildBestOfNPlan,
    buildImplementReviewPlan,
    executeBestOfNPlaybook,
    executeImplementReviewPlaybook,
    generatePlaybookBranchNames,
    validatePlaybookBranchPrefix
} from '../../swarmPlaybooks';
import { createHerdrWorkspace, splitHerdrPane } from '../../worktreeManager';

describe('swarmPlaybooks Unit Tests', () => {
    let originalExecFile: any;

    beforeEach(() => {
        resetMockState();
        originalExecFile = cp.execFile;
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
    });

    describe('generatePlaybookBranchNames & validatePlaybookBranchPrefix', () => {
        it('generates N unique sequential branch names while skipping existing branches and slug collisions', () => {
            const branches = generatePlaybookBranchNames('swarm/best/', 3, ['swarm/best-1', 'swarm-best-3']);
            expect(branches).to.deep.equal(['swarm/best-2', 'swarm/best-4', 'swarm/best-5']);
        });

        it('rejects invalid Git branch prefixes including slash-only or .lock suffixes', () => {
            expect(() => generatePlaybookBranchNames('-bad-prefix', 2)).to.throw();
            expect(() => generatePlaybookBranchNames('has spaces', 2)).to.throw();
            expect(() => generatePlaybookBranchNames('///', 2)).to.throw();
            expect(validatePlaybookBranchPrefix('/')).to.be.a('string');
            expect(validatePlaybookBranchPrefix('/leading')).to.be.a('string');
            expect(validatePlaybookBranchPrefix('feat.lock')).to.be.a('string');
            expect(validatePlaybookBranchPrefix('swarm/best/')).to.be.null;
        });
    });

    describe('buildBestOfNPlan & buildImplementReviewPlan', () => {
        it('builds isolated worktrees, unique agent names, and candidate prompts for Best-of-N', () => {
            const existing = new Set<string>(['swarm-best-1-claude']);
            const plan = buildBestOfNPlan({
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                branchPrefix: 'swarm/best',
                existingBranches: ['main'],
                locationPref: '.worktrees',
                agents: [
                    { label: 'Claude Code', cmd: 'claude', agentKind: 'claude' },
                    { label: 'Codex CLI', cmd: 'codex', agentKind: 'codex' }
                ],
                taskPrompt: 'Add rate limiter middleware',
                existingAgentNames: existing
            });

            expect(plan).to.have.lengthOf(2);
            expect(plan[0].branchName).to.equal('swarm/best-1');
            expect(plan[0].worktreePath).to.equal(path.join('/repos/demo', '.worktrees', 'swarm-best-1'));
            expect(plan[0].agentName).to.equal('swarm-best-1-claude-2');
            expect(plan[0].prompt).to.include('Candidate 1/2');
            expect(plan[0].prompt).to.include('Add rate limiter middleware');

            expect(plan[1].branchName).to.equal('swarm/best-2');
            expect(plan[1].worktreePath).to.equal(path.join('/repos/demo', '.worktrees', 'swarm-best-2'));
            expect(plan[1].agentName).to.equal('swarm-best-2-codex');
            expect(plan[1].prompt).to.include('Candidate 2/2');
        });

        it('builds coordinated Implementer + Reviewer plan for new-worktree and current-workspace', () => {
            const wtPlan = buildImplementReviewPlan({
                topology: 'new-worktree',
                repoRoot: '/repos/demo',
                branchName: 'feat/pay-retry',
                baseBranch: 'main',
                locationPref: 'sibling',
                implementer: { label: 'Claude', cmd: 'claude', agentKind: 'claude' },
                reviewer: { label: 'Codex', cmd: 'codex', agentKind: 'codex' },
                taskPrompt: 'Implement idempotent retries'
            });

            expect(wtPlan.worktreePath).to.equal(path.join('/repos', 'demo-feat-pay-retry'));
            expect(wtPlan.implementer.agentName).to.equal('impl-feat-pay-retry');
            expect(wtPlan.reviewer.agentName).to.equal('review-feat-pay-retry');
            expect(wtPlan.implementer.prompt).to.include('review-feat-pay-retry');
            expect(wtPlan.reviewer.prompt).to.include('impl-feat-pay-retry');
            expect(wtPlan.reviewer.prompt).to.include('Do NOT edit source files');

            const localPlan = buildImplementReviewPlan({
                topology: 'current-workspace',
                repoRoot: '/repos/demo',
                currentBranch: 'main',
                locationPref: 'sibling',
                implementer: { cmd: 'claude', agentKind: 'claude' },
                reviewer: { cmd: 'gemini', agentKind: 'gemini' },
                taskPrompt: 'Fix flaky parser'
            });

            expect(localPlan.worktreePath).to.equal('/repos/demo');
            expect(localPlan.workspaceLabel).to.equal('demo (main)');
            expect(localPlan.implementer.agentName).to.equal('impl-main');
            expect(localPlan.reviewer.agentName).to.equal('review-main');
        });
    });

    describe('executeBestOfNPlaybook & executeImplementReviewPlaybook', () => {
        it('provisions N candidates sequentially and isolates partial failures', async () => {
            const calls: string[] = [];
            const candidates = buildBestOfNPlan({
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                branchPrefix: 'swarm/cand',
                existingBranches: [],
                locationPref: 'sibling',
                agents: [
                    { cmd: 'claude', agentKind: 'claude' },
                    { cmd: 'codex', agentKind: 'codex' },
                    { cmd: 'gemini', agentKind: 'gemini' }
                ],
                taskPrompt: 'Solve caching'
            });

            const res = await executeBestOfNPlaybook({
                sessionName: 'vscode',
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                locationPref: 'sibling',
                candidates,
                deps: {
                    createWorktreeFn: async (_root, branch) => {
                        calls.push(`wt:${branch}`);
                        if (branch === 'swarm/cand-2') {
                            throw new Error('git worktree collision');
                        }
                    },
                    createHerdrWorkspaceFn: async (opts) => {
                        calls.push(`ws:${opts.label}:focus=${Boolean(opts.focus)}`);
                        const idx = opts.label?.endsWith('-1') ? 1 : 3;
                        return { workspaceId: `w${idx}`, rootPaneId: `w${idx}:p1` };
                    },
                    startAgentInPaneFn: async (opts) => {
                        calls.push(`start:${opts.agentName}@${opts.paneId}`);
                        return { method: 'native', started: true, prompted: true };
                    }
                }
            });

            expect(res.playbook).to.equal('best-of-n');
            expect(res.launched).to.have.lengthOf(2);
            expect(res.failures).to.have.lengthOf(1);
            expect(res.failures[0].branchName).to.equal('swarm/cand-2');
            expect(res.failures[0].error).to.include('git worktree collision');
            expect(res.primaryWorkspaceId).to.equal('w1');
            expect(calls).to.deep.equal([
                'wt:swarm/cand-1',
                'ws:swarm/cand-1:focus=true',
                'start:swarm-cand-1-claude@w1:p1',
                'wt:swarm/cand-2',
                'wt:swarm/cand-3',
                'ws:swarm/cand-3:focus=false',
                'start:swarm-cand-3-gemini@w3:p1'
            ]);
        });

        it('selects first successfully launched candidate as primaryWorkspaceId when candidate 1 fails after workspace creation', async () => {
            const candidates = buildBestOfNPlan({
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                branchPrefix: 'swarm/fallback',
                existingBranches: [],
                locationPref: 'sibling',
                agents: [
                    { cmd: 'claude', agentKind: 'claude' },
                    { cmd: 'codex', agentKind: 'codex' }
                ],
                taskPrompt: 'Test primary fallback'
            });

            const res = await executeBestOfNPlaybook({
                sessionName: 'vscode',
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                locationPref: 'sibling',
                candidates,
                deps: {
                    createWorktreeFn: async () => {},
                    createHerdrWorkspaceFn: async (opts) => {
                        if (opts.label?.endsWith('-1')) {
                            return { workspaceId: 'w1', rootPaneId: '' };
                        }
                        return { workspaceId: 'w2', rootPaneId: 'w2:p1' };
                    },
                    startAgentInPaneFn: async () => ({ method: 'native', started: true, prompted: true })
                }
            });

            expect(res.launched).to.have.lengthOf(1);
            expect(res.failures).to.have.lengthOf(1);
            expect(res.primaryWorkspaceId).to.equal('w2');
            expect(res.launched[0].branchName).to.equal('swarm/fallback-2');
        });

        it('creates split panes right and launches Implementer + Reviewer in the shared worktree', async () => {
            const plan = buildImplementReviewPlan({
                topology: 'new-worktree',
                repoRoot: '/repos/demo',
                branchName: 'feat/duo',
                baseBranch: 'main',
                locationPref: 'sibling',
                implementer: { cmd: 'claude', agentKind: 'claude' },
                reviewer: { cmd: 'codex', agentKind: 'codex' },
                taskPrompt: 'Add telemetry'
            });

            const startedPanes: Array<{ paneId: string; agentName: string; cwd?: string }> = [];
            let splitArgs: any;

            const res = await executeImplementReviewPlaybook({
                sessionName: 'vscode',
                repoRoot: '/repos/demo',
                locationPref: 'sibling',
                plan,
                deps: {
                    createWorktreeFn: async () => {},
                    createHerdrWorkspaceFn: async () => ({ workspaceId: 'w9', rootPaneId: 'w9:p1' }),
                    splitHerdrPaneFn: async (opts) => {
                        splitArgs = opts;
                        return 'w9:p2';
                    },
                    startAgentInPaneFn: async (opts) => {
                        startedPanes.push({ paneId: opts.paneId, agentName: opts.agentName, cwd: opts.cwd });
                        return { method: 'native', started: true, prompted: true };
                    }
                }
            });

            expect(res.launched).to.have.lengthOf(2);
            expect(res.failures).to.be.empty;
            expect(res.primaryWorkspaceId).to.equal('w9');
            expect(splitArgs).to.include({
                direction: 'right',
                targetPaneId: 'w9:p1',
                workspaceId: 'w9',
                cwd: plan.worktreePath,
                focus: false
            });
            expect(startedPanes).to.deep.equal([
                { paneId: 'w9:p1', agentName: 'impl-feat-duo', cwd: plan.worktreePath },
                { paneId: 'w9:p2', agentName: 'review-feat-duo', cwd: plan.worktreePath }
            ]);
        });

        it('invokes bootstrapWorktreeFn after worktree creation and surfaces non-fatal setup warnings', async () => {
            const bootCalls: Array<{ repoRoot: string; wtPath: string }> = [];
            const candidates = buildBestOfNPlan({
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                branchPrefix: 'swarm/boot',
                existingBranches: [],
                locationPref: 'sibling',
                agents: [{ cmd: 'claude', agentKind: 'claude' }],
                taskPrompt: 'Bootstrap test'
            });

            const bestOfNRes = await executeBestOfNPlaybook({
                sessionName: 'vscode',
                repoRoot: '/repos/demo',
                baseBranch: 'main',
                locationPref: 'sibling',
                candidates,
                bootstrapOptions: { copyFiles: ['.env'], postCreateCommand: 'pnpm install' },
                deps: {
                    createWorktreeFn: async () => {},
                    bootstrapWorktreeFn: async (repoRoot, wtPath) => {
                        bootCalls.push({ repoRoot, wtPath });
                        return {
                            copiedFiles: ['.env'],
                            skippedFiles: [],
                            postCreateRan: true,
                            postCreateSucceeded: false,
                            warnings: ['postCreateCommand failed: offline']
                        };
                    },
                    createHerdrWorkspaceFn: async () => ({ workspaceId: 'w1', rootPaneId: 'w1:p1' }),
                    startAgentInPaneFn: async () => ({ method: 'native', started: true, prompted: true })
                }
            });

            expect(bootCalls).to.have.lengthOf(1);
            expect(bootCalls[0].wtPath).to.equal(candidates[0].worktreePath);
            expect(bestOfNRes.launched).to.have.lengthOf(1);
            expect(bestOfNRes.warnings).to.deep.equal(['postCreateCommand failed: offline']);

            const implPlan = buildImplementReviewPlan({
                topology: 'new-worktree',
                repoRoot: '/repos/demo',
                branchName: 'feat/boot-duo',
                baseBranch: 'main',
                locationPref: 'sibling',
                implementer: { cmd: 'claude', agentKind: 'claude' },
                reviewer: { cmd: 'codex', agentKind: 'codex' },
                taskPrompt: 'Bootstrap duo test'
            });

            const implRes = await executeImplementReviewPlaybook({
                sessionName: 'vscode',
                repoRoot: '/repos/demo',
                locationPref: 'sibling',
                plan: implPlan,
                bootstrapOptions: { copyFiles: ['.env'], postCreateCommand: '' },
                deps: {
                    createWorktreeFn: async () => {},
                    bootstrapWorktreeFn: async (repoRoot, wtPath) => {
                        bootCalls.push({ repoRoot, wtPath });
                        return {
                            copiedFiles: ['.env'],
                            skippedFiles: [],
                            postCreateRan: false,
                            postCreateSucceeded: true,
                            warnings: []
                        };
                    },
                    createHerdrWorkspaceFn: async () => ({ workspaceId: 'w2', rootPaneId: 'w2:p1' }),
                    splitHerdrPaneFn: async () => 'w2:p2',
                    startAgentInPaneFn: async () => ({ method: 'native', started: true, prompted: true })
                }
            });

            expect(bootCalls).to.have.lengthOf(2);
            expect(bootCalls[1].wtPath).to.equal(implPlan.worktreePath);
            expect(implRes.launched).to.have.lengthOf(2);
            expect(implRes.warnings).to.be.undefined;

            const failWsRes = await executeImplementReviewPlaybook({
                sessionName: 'vscode',
                repoRoot: '/repos/demo',
                locationPref: 'sibling',
                plan: implPlan,
                bootstrapOptions: { copyFiles: ['.env'], postCreateCommand: 'pnpm install' },
                deps: {
                    createWorktreeFn: async () => {},
                    bootstrapWorktreeFn: async () => ({
                        copiedFiles: [],
                        skippedFiles: [],
                        postCreateRan: true,
                        postCreateSucceeded: false,
                        warnings: ['postCreateCommand failed: offline']
                    }),
                    createHerdrWorkspaceFn: async () => {
                        throw new Error('daemon unavailable');
                    }
                }
            });
            expect(failWsRes.failures).to.have.lengthOf(1);
            expect(failWsRes.warnings).to.deep.equal(['postCreateCommand failed: offline']);
        });
    });

    describe('createHerdrWorkspace & splitHerdrPane helpers', () => {
        it('uses native socket RPC when connected', async () => {
            const fakeSocket: any = {
                isConnected: true,
                createWorkspace: async () => ({ workspace: { workspace_id: 'w4' }, tab: { tab_id: 'w4:t1' }, root_pane: { pane_id: 'w4:p1' } }),
                splitPane: async () => ({ pane: { pane_id: 'w4:p2' } })
            };

            const ws = await createHerdrWorkspace({
                sessionName: 'vscode',
                cwd: '/repos/wt',
                label: 'feat/wt',
                socketClient: fakeSocket
            });
            expect(ws).to.deep.equal({ workspaceId: 'w4', tabId: 'w4:t1', rootPaneId: 'w4:p1' });

            const newPane = await splitHerdrPane({
                sessionName: 'vscode',
                direction: 'right',
                targetPaneId: ws.rootPaneId,
                workspaceId: ws.workspaceId,
                cwd: '/repos/wt',
                socketClient: fakeSocket
            });
            expect(newPane).to.equal('w4:p2');
        });

        it('falls back to CLI when socket is disconnected', async () => {
            const invokedArgs: string[][] = [];
            (cp as any).execFile = (_file: string, args: string[], _opts: any, cb: any) => {
                invokedArgs.push(args);
                const callback = typeof _opts === 'function' ? _opts : cb;
                if (args.includes('workspace')) {
                    callback(null, JSON.stringify({ result: { workspace: { workspace_id: 'w7' }, root_pane: { pane_id: 'w7:p1' } } }), '');
                } else {
                    callback(null, JSON.stringify({ result: { pane: { pane_id: 'w7:p2' } } }), '');
                }
            };

            const ws = await createHerdrWorkspace({
                sessionName: 'vscode',
                cwd: '/repos/wt',
                label: 'feat/cli'
            });
            expect(ws.workspaceId).to.equal('w7');
            expect(ws.rootPaneId).to.equal('w7:p1');

            const paneId = await splitHerdrPane({
                sessionName: 'vscode',
                direction: 'right',
                targetPaneId: ws.rootPaneId,
                cwd: '/repos/wt'
            });
            expect(paneId).to.equal('w7:p2');
            expect(invokedArgs[0]).to.include.members(['workspace', 'create', '--cwd', '/repos/wt', '--label', 'feat/cli', '--no-focus']);
            expect(invokedArgs[1]).to.include.members(['pane', 'split', '--direction', 'right', '--pane', 'w7:p1', '--no-focus']);
        });
    });
});
