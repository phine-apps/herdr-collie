/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runGitCmd } from '../../executors';
import {
    getRepoRoot,
    listGitWorktrees,
    listGitBranches,
    getCurrentGitBranch,
    createWorktree,
    removeWorktree,
    mergeWorktreeBranch,
    resolveWorktreePath,
    sanitizeBranchSlug
} from '../../worktreeManager';

describe('Smart Swarm & Git Worktree Integration Tests (W-01 ~ W-06, A-02, A-05)', function() {
    this.timeout(15000);

    let tempRootDir: string;
    let mainRepoDir: string;

    beforeEach(async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-wt-int-'));
        mainRepoDir = path.join(tempRootDir, 'main-repo');
        fs.mkdirSync(mainRepoDir, { recursive: true });

        // Initialize Git repo with an initial commit
        await runGitCmd(['init', '-b', 'main'], mainRepoDir);
        await runGitCmd(['config', 'user.name', 'Collie Test User'], mainRepoDir);
        await runGitCmd(['config', 'user.email', 'collie@example.com'], mainRepoDir);

        const readmePath = path.join(mainRepoDir, 'README.md');
        fs.writeFileSync(readmePath, '# Main Repository\nInitial content\n', 'utf8');
        await runGitCmd(['add', 'README.md'], mainRepoDir);
        await runGitCmd(['commit', '-m', 'chore: initial commit'], mainRepoDir);
    });

    afterEach(async () => {
        try {
            // Clean up any locked worktrees first if possible
            if (fs.existsSync(mainRepoDir)) {
                await runGitCmd(['worktree', 'prune'], mainRepoDir).catch(() => {});
            }
            fs.rmSync(tempRootDir, { recursive: true, force: true });
        } catch (e) {}
    });

    describe('Repository and Branch Inspection', () => {
        it('identifies repository root directory accurately', async () => {
            const root = await getRepoRoot(mainRepoDir);
            expect(root).to.equal(fs.realpathSync(mainRepoDir));
        });

        it('returns null when querying a non-git directory (A-02)', async () => {
            const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
            try {
                const root = await getRepoRoot(nonGitDir);
                expect(root).to.be.null;
            } finally {
                fs.rmSync(nonGitDir, { recursive: true, force: true });
            }
        });

        it('detects current active branch and branch list', async () => {
            const currentBranch = await getCurrentGitBranch(mainRepoDir);
            expect(currentBranch).to.equal('main');

            const branches = await listGitBranches(mainRepoDir);
            expect(branches).to.include('main');
        });
    });

    describe('Worktree Lifecycle: Creation, Inspection, Merging, and Cleanup (W-01 ~ W-06)', () => {
        it('creates a new worktree on a new branch and verifies in listGitWorktrees', async () => {
            const branchName = 'feature/swarm-task-1';
            const worktreePath = resolveWorktreePath(mainRepoDir, branchName, 'sibling');

            await createWorktree(mainRepoDir, branchName, worktreePath, 'main');

            // Verify filesystem
            expect(fs.existsSync(worktreePath)).to.be.true;
            expect(fs.existsSync(path.join(worktreePath, 'README.md'))).to.be.true;

            // Verify git worktree list
            const worktrees = await listGitWorktrees(mainRepoDir);
            expect(worktrees.length).to.be.at.least(2);

            const createdWt = worktrees.find(w => w.branch === branchName);
            expect(createdWt).to.not.be.undefined;
            expect(fs.realpathSync(createdWt!.worktree)).to.equal(fs.realpathSync(worktreePath));
        });

        it('creates a worktree in .worktrees subfolder when configured', async () => {
            const branchName = 'feature/subfolder-swarm';
            const worktreePath = resolveWorktreePath(mainRepoDir, branchName, '.worktrees');

            await createWorktree(mainRepoDir, branchName, worktreePath, 'main');

            expect(fs.existsSync(worktreePath)).to.be.true;
            expect(worktreePath).to.include(path.join(mainRepoDir, '.worktrees'));

            const worktrees = await listGitWorktrees(mainRepoDir);
            const found = worktrees.find(w => w.branch === branchName);
            expect(found).to.not.be.undefined;
        });

        it('merges worktree changes back to the main branch cleanly (W-05)', async () => {
            const branchName = 'feature/add-feature-file';
            const worktreePath = resolveWorktreePath(mainRepoDir, branchName, 'sibling');

            await createWorktree(mainRepoDir, branchName, worktreePath, 'main');

            // Make a commit inside the worktree
            const newFilePath = path.join(worktreePath, 'FEATURE.md');
            fs.writeFileSync(newFilePath, '# New Feature by AI Agent\n', 'utf8');
            await runGitCmd(['add', 'FEATURE.md'], worktreePath);
            await runGitCmd(['commit', '-m', 'feat: add feature file by agent'], worktreePath);

            // Merge back into main repository
            const mergeOutput = await mergeWorktreeBranch(mainRepoDir, branchName);
            expect(mergeOutput).to.include('FEATURE.md');

            // Verify file exists on main branch
            const mergedFilePath = path.join(mainRepoDir, 'FEATURE.md');
            expect(fs.existsSync(mergedFilePath)).to.be.true;
            const content = fs.readFileSync(mergedFilePath, 'utf8');
            expect(content).to.include('New Feature by AI Agent');
        });

        it('throws an error and prevents merge when conflicts occur (A-05)', async () => {
            const branchName = 'feature/conflict-branch';
            const worktreePath = resolveWorktreePath(mainRepoDir, branchName, 'sibling');

            await createWorktree(mainRepoDir, branchName, worktreePath, 'main');

            // Commit change in worktree
            const wtFile = path.join(worktreePath, 'README.md');
            fs.writeFileSync(wtFile, '# Main Repository\nAgent Modification\n', 'utf8');
            await runGitCmd(['add', 'README.md'], worktreePath);
            await runGitCmd(['commit', '-m', 'feat: modify readme in worktree'], worktreePath);

            // Commit conflicting change in main repository
            const mainFile = path.join(mainRepoDir, 'README.md');
            fs.writeFileSync(mainFile, '# Main Repository\nConflicting Main Modification\n', 'utf8');
            await runGitCmd(['add', 'README.md'], mainRepoDir);
            await runGitCmd(['commit', '-m', 'fix: conflicting change in main'], mainRepoDir);

            // Attempting to merge should throw conflict error
            let mergeFailed = false;
            let mergeErrorMessage = '';
            try {
                await mergeWorktreeBranch(mainRepoDir, branchName);
            } catch (e: any) {
                mergeFailed = true;
                mergeErrorMessage = e.message || '';
            } finally {
                // Abort merge to keep repo clean
                await runGitCmd(['merge', '--abort'], mainRepoDir).catch(() => {});
            }

            expect(mergeFailed, 'Merge should have failed due to conflict').to.be.true;
            expect(mergeErrorMessage.toLowerCase()).to.include('conflict');
        });

        it('removes worktree cleanly and prunes it from listGitWorktrees (W-06)', async () => {
            const branchName = 'feature/cleanup-task';
            const worktreePath = resolveWorktreePath(mainRepoDir, branchName, 'sibling');

            await createWorktree(mainRepoDir, branchName, worktreePath, 'main');
            expect(fs.existsSync(worktreePath)).to.be.true;

            // Remove worktree
            await removeWorktree(mainRepoDir, worktreePath, true);

            // Directory should no longer exist
            expect(fs.existsSync(worktreePath)).to.be.false;

            // Should be removed from worktree list
            const worktrees = await listGitWorktrees(mainRepoDir);
            const found = worktrees.find(w => w.branch === branchName);
            expect(found).to.be.undefined;
        });
    });
});
