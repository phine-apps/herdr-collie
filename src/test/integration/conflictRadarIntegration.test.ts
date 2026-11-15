/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { mockState, resetMockState, mockVscode } from '../helpers/mockVscode';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runGitCmd } from '../../executors';
import { createWorktree, removeWorktree } from '../../worktreeManager';
import { scanWorktreeFileConflicts, WorktreeConflictRadar } from '../../conflictRadar';

describe('Parallel Worktree Conflict Radar Integration Tests', function() {
    this.timeout(15000);

    let tempRootDir: string;
    let mainRepoDir: string;
    let wtDirA: string;
    let wtDirB: string;

    beforeEach(async () => {
        resetMockState();
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-radar-int-'));
        mainRepoDir = path.join(tempRootDir, 'main-repo');
        wtDirA = path.join(tempRootDir, 'wt-a');
        wtDirB = path.join(tempRootDir, 'wt-b');
        fs.mkdirSync(mainRepoDir, { recursive: true });

        await runGitCmd(['init', '-b', 'main'], mainRepoDir);
        await runGitCmd(['config', 'user.name', 'Radar Tester'], mainRepoDir);
        await runGitCmd(['config', 'user.email', 'radar@example.com'], mainRepoDir);

        fs.mkdirSync(path.join(mainRepoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(mainRepoDir, 'src', 'shared.ts'), 'export const v = 1;\n', 'utf8');
        fs.writeFileSync(path.join(mainRepoDir, 'src', 'dirtyOverlap.ts'), 'export const d = 1;\n', 'utf8');
        await runGitCmd(['add', '-A'], mainRepoDir);
        await runGitCmd(['commit', '-m', 'chore: init'], mainRepoDir);

        await createWorktree(mainRepoDir, 'feat/alpha', wtDirA, 'main');
        await createWorktree(mainRepoDir, 'feat/beta', wtDirB, 'main');
    });

    afterEach(async () => {
        await removeWorktree(mainRepoDir, wtDirA, true).catch(() => {});
        await removeWorktree(mainRepoDir, wtDirB, true).catch(() => {});
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    });

    it('detects both committed divergence (medium) and dirty concurrent edits (high) across real Git worktrees', async () => {
        // Worktree A: commit change to shared.ts + uncommitted change to dirtyOverlap.ts + isolated file
        fs.writeFileSync(path.join(wtDirA, 'src', 'shared.ts'), 'export const v = 2;\n', 'utf8');
        await runGitCmd(['add', 'src/shared.ts'], wtDirA);
        await runGitCmd(['commit', '-m', 'feat(a): update shared'], wtDirA);
        fs.writeFileSync(path.join(wtDirA, 'src', 'dirtyOverlap.ts'), 'export const d = 2;\n', 'utf8');
        fs.writeFileSync(path.join(wtDirA, 'src', 'onlyA.ts'), 'export const a = 1;\n', 'utf8');

        // Worktree B: commit change to shared.ts + uncommitted change to dirtyOverlap.ts + isolated file
        fs.writeFileSync(path.join(wtDirB, 'src', 'shared.ts'), 'export const v = 3;\n', 'utf8');
        await runGitCmd(['add', 'src/shared.ts'], wtDirB);
        await runGitCmd(['commit', '-m', 'feat(b): update shared'], wtDirB);
        fs.writeFileSync(path.join(wtDirB, 'src', 'dirtyOverlap.ts'), 'export const d = 3;\n', 'utf8');
        fs.writeFileSync(path.join(wtDirB, 'src', 'onlyB.ts'), 'export const b = 1;\n', 'utf8');

        const result = await scanWorktreeFileConflicts(mainRepoDir, [
            { id: 'agent-a', name: 'claude-alpha', cwd: wtDirA },
            { id: 'agent-b', name: 'codex-beta', cwd: wtDirB }
        ]);

        expect(result.worktreeCount).to.equal(3);
        expect(result.conflicts.map(c => c.filePath)).to.deep.equal([
            'src/dirtyOverlap.ts',
            'src/shared.ts'
        ]);

        const highCluster = result.conflicts[0];
        expect(highCluster.severity).to.equal('high');
        expect(highCluster.touches).to.have.lengthOf(2);
        expect(highCluster.touches.every(t => t.dirty)).to.be.true;
        expect(highCluster.touches.map(t => t.agentId).sort()).to.deep.equal(['agent-a', 'agent-b']);

        const mediumCluster = result.conflicts[1];
        expect(mediumCluster.severity).to.equal('medium');
        expect(mediumCluster.touches.every(t => !t.dirty)).to.be.true;
    });

    it('updates StatusBar, FileDecorationProvider, and launches vscode.diff via showConflictRadarWizard', async () => {
        fs.writeFileSync(path.join(wtDirA, 'src', 'dirtyOverlap.ts'), 'export const d = 10;\n', 'utf8');
        fs.writeFileSync(path.join(wtDirB, 'src', 'dirtyOverlap.ts'), 'export const d = 20;\n', 'utf8');

        const radar = new WorktreeConflictRadar({
            getRepoRoot: async () => mainRepoDir,
            getActiveAgents: () => [],
            dispatchPrompt: async () => true
        });

        try {
            // mockVscode.showQuickPick selects the first item (first file -> first action = Compare Between Two Worktrees)
            await radar.showConflictRadarWizard();

            const sb = mockState.statusBarItems.find(i => i.id === 'herdr-collie.conflictRadar');
            expect(sb?.visible).to.be.true;
            expect(sb?.text).to.include('Overlap: 1');

            const dec = radar.provideFileDecoration(mockVscode.Uri.file(path.join(wtDirA, 'src', 'dirtyOverlap.ts')) as any);
            expect(dec?.badge).to.equal('!2');

            const diffCall = mockState.executedCommands.find(c => c.command === 'vscode.diff');
            expect(diffCall).to.exist;
            expect(diffCall?.args[2]).to.include('dirtyOverlap.ts');
        } finally {
            radar.dispose();
        }
    });
});
