/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { resetMockState } from '../helpers/mockVscode';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGitCmd } from '../../executors';
import { listGitWorktrees, removeWorktree } from '../../worktreeManager';
import {
    buildBestOfNPlan,
    buildImplementReviewPlan,
    executeBestOfNPlaybook,
    executeImplementReviewPlaybook
} from '../../swarmPlaybooks';

describe('Swarm Playbooks Integration Tests (Real Git Worktrees)', function() {
    this.timeout(15000);

    let tempRootDir: string;
    let mainRepoDir: string;
    const createdWorktreeDirs: string[] = [];

    beforeEach(async () => {
        resetMockState();
        createdWorktreeDirs.length = 0;
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-playbook-int-'));
        mainRepoDir = path.join(tempRootDir, 'repo');
        fs.mkdirSync(mainRepoDir, { recursive: true });

        await runGitCmd(['init', '-b', 'main'], mainRepoDir);
        await runGitCmd(['config', 'user.name', 'Playbook Tester'], mainRepoDir);
        await runGitCmd(['config', 'user.email', 'playbook@example.com'], mainRepoDir);

        fs.writeFileSync(path.join(mainRepoDir, 'README.md'), '# Demo\n', 'utf8');
        await runGitCmd(['add', '-A'], mainRepoDir);
        await runGitCmd(['commit', '-m', 'chore: init'], mainRepoDir);
    });

    afterEach(async () => {
        for (const wt of createdWorktreeDirs) {
            try {
                await removeWorktree(mainRepoDir, wt, true);
            } catch {}
        }
        try {
            fs.rmSync(tempRootDir, { recursive: true, force: true });
        } catch {}
    });

    it('provisions real isolated Git worktrees for Best-of-N candidates and launches agents per candidate', async () => {
        const plan = buildBestOfNPlan({
            repoRoot: mainRepoDir,
            baseBranch: 'main',
            branchPrefix: 'swarm/best',
            existingBranches: ['main'],
            locationPref: '.worktrees',
            agents: [
                { label: 'Claude', cmd: 'claude', agentKind: 'claude' },
                { label: 'Codex', cmd: 'codex', agentKind: 'codex' }
            ],
            taskPrompt: 'Implement health check endpoint'
        });

        for (const c of plan) {
            createdWorktreeDirs.push(c.worktreePath);
        }

        const startedAgents: Array<{ agentName: string; cwd?: string; prompt?: string }> = [];
        const result = await executeBestOfNPlaybook({
            sessionName: 'vscode',
            repoRoot: mainRepoDir,
            baseBranch: 'main',
            locationPref: '.worktrees',
            candidates: plan,
            deps: {
                createHerdrWorkspaceFn: async (opts) => ({
                    workspaceId: `ws-${path.basename(opts.cwd)}`,
                    rootPaneId: `ws-${path.basename(opts.cwd)}:p1`
                }),
                startAgentInPaneFn: async (opts) => {
                    startedAgents.push({ agentName: opts.agentName, cwd: opts.cwd, prompt: opts.prompt });
                    return { method: 'native', started: true, prompted: true };
                }
            }
        });

        expect(result.launched).to.have.lengthOf(2);
        expect(result.failures).to.be.empty;

        const worktrees = await listGitWorktrees(mainRepoDir);
        const branchNames = worktrees.map(w => w.branch);
        expect(branchNames).to.include('swarm/best-1');
        expect(branchNames).to.include('swarm/best-2');
        expect(fs.existsSync(path.join(plan[0].worktreePath, 'README.md'))).to.be.true;
        expect(fs.existsSync(path.join(plan[1].worktreePath, 'README.md'))).to.be.true;

        expect(startedAgents.map(a => a.agentName)).to.deep.equal(['swarm-best-1-claude', 'swarm-best-2-codex']);
        expect(startedAgents[0].prompt).to.include('Candidate 1/2');
        expect(startedAgents[1].prompt).to.include('Candidate 2/2');
    });

    it('provisions a shared Git worktree and launches Implementer + Reviewer in split panes', async () => {
        const plan = buildImplementReviewPlan({
            topology: 'new-worktree',
            repoRoot: mainRepoDir,
            branchName: 'feat/impl-review',
            baseBranch: 'main',
            locationPref: 'sibling',
            implementer: { label: 'Claude', cmd: 'claude', agentKind: 'claude' },
            reviewer: { label: 'Codex', cmd: 'codex', agentKind: 'codex' },
            taskPrompt: 'Add request validation'
        });
        createdWorktreeDirs.push(plan.worktreePath);

        const launchedRoles: Array<{ agentName: string; paneId: string; cwd?: string }> = [];
        const result = await executeImplementReviewPlaybook({
            sessionName: 'vscode',
            repoRoot: mainRepoDir,
            locationPref: 'sibling',
            plan,
            deps: {
                createHerdrWorkspaceFn: async () => ({
                    workspaceId: 'w10',
                    rootPaneId: 'w10:p1'
                }),
                splitHerdrPaneFn: async (opts) => {
                    expect(opts.direction).to.equal('right');
                    expect(opts.cwd).to.equal(plan.worktreePath);
                    return 'w10:p2';
                },
                startAgentInPaneFn: async (opts) => {
                    launchedRoles.push({ agentName: opts.agentName, paneId: opts.paneId, cwd: opts.cwd });
                    return { method: 'native', started: true, prompted: true };
                }
            }
        });

        expect(result.launched).to.have.lengthOf(2);
        expect(result.failures).to.be.empty;

        const worktrees = await listGitWorktrees(mainRepoDir);
        expect(worktrees.map(w => w.branch)).to.include('feat/impl-review');
        expect(fs.existsSync(path.join(plan.worktreePath, 'README.md'))).to.be.true;
        expect(launchedRoles).to.deep.equal([
            { agentName: 'impl-feat-impl-review', paneId: 'w10:p1', cwd: plan.worktreePath },
            { agentName: 'review-feat-impl-review', paneId: 'w10:p2', cwd: plan.worktreePath }
        ]);
    });
});
