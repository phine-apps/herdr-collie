/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import '../helpers/mockVscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runGitCmd } from '../../executors';
import {
    HerdrReviewController,
    extractSnippetFromFile,
    formatReviewFeedback,
    ReviewCommentItem,
    HerdrReviewChangesProvider,
    prepareOriginalFileForDiff,
    resolveDiffTargets,
    getRepoChangedFiles,
    createReviewCheckpoint,
    rollbackReviewCheckpoint,
    listReviewCheckpoints
} from '../../reviewManager';

describe('Integrated Review & Diff-to-Prompt Integration Tests (P3)', function() {
    this.timeout(10000);

    let tempRepoDir: string;

    beforeEach(async () => {
        tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-review-int-'));

        await runGitCmd(['init', '-b', 'main'], tempRepoDir);
        await runGitCmd(['config', 'user.name', 'Review Tester'], tempRepoDir);
        await runGitCmd(['config', 'user.email', 'review@example.com'], tempRepoDir);

        // Create sample source files
        const authFile = path.join(tempRepoDir, 'auth.ts');
        fs.writeFileSync(authFile, [
            'export function login(user: string, pass: string) {',
            '    if (!user) {',
            '        throw new Error("Missing user");',
            '    }',
            '    return true;',
            '}'
        ].join('\n'), 'utf8');

        const configFile = path.join(tempRepoDir, 'config.ts');
        fs.writeFileSync(configFile, [
            'export const config = {',
            '    debug: true,',
            '    port: 8080',
            '};'
        ].join('\n'), 'utf8');

        await runGitCmd(['add', '.'], tempRepoDir);
        await runGitCmd(['commit', '-m', 'feat: initial auth and config'], tempRepoDir);
    });

    afterEach(() => {
        try {
            fs.rmSync(tempRepoDir, { recursive: true, force: true });
        } catch {}
    });

    it('extracts live code snippets directly from disk for review comments', () => {
        const authFile = path.join(tempRepoDir, 'auth.ts');
        const snippet = extractSnippetFromFile(authFile, 2, 4);

        expect(snippet).to.equal([
            '    if (!user) {',
            '        throw new Error("Missing user");',
            '    }'
        ].join('\n'));
    });

    it('manages full review lifecycle: add comments across files, format prompt, and clear', () => {
        const controller = new HerdrReviewController();

        const comment1: ReviewCommentItem = {
            id: 'c1',
            filePath: 'auth.ts',
            fileName: 'auth.ts',
            startLine: 3,
            endLine: 3,
            codeSnippet: '        throw new Error("Missing user");',
            commentText: 'Use AuthValidationError instead of generic Error.'
        };

        const comment2: ReviewCommentItem = {
            id: 'c2',
            filePath: 'config.ts',
            fileName: 'config.ts',
            startLine: 2,
            endLine: 2,
            codeSnippet: '    debug: true,',
            commentText: 'Disable debug flag in production.'
        };

        controller.addComment(comment1);
        controller.addComment(comment2);

        expect(controller.commentCount).to.equal(2);

        const prompt = controller.formatPrompt({
            agentName: 'claude',
            branchName: 'feat/auth-flow',
            customInstruction: 'Re-run vitest after applying fixes.'
        });

        expect(prompt).to.include('## 🔍 Code Review Feedback to claude');
        expect(prompt).to.include('**Branch / Worktree:** `feat/auth-flow`');
        expect(prompt).to.include('### 📄 `auth.ts`');
        expect(prompt).to.include('### 📄 `config.ts`');
        expect(prompt).to.include('#### 💬 Line 3');
        expect(prompt).to.include('```typescript');
        expect(prompt).to.include('throw new Error("Missing user");');
        expect(prompt).to.include('> Use AuthValidationError instead of generic Error.');
        expect(prompt).to.include('#### 💬 Line 2');
        expect(prompt).to.include('debug: true,');
        expect(prompt).to.include('> Disable debug flag in production.');
        expect(prompt).to.include('Re-run vitest after applying fixes.');

        // Verify clearAll
        controller.clearAll();
        expect(controller.commentCount).to.equal(0);
        expect(controller.formatPrompt()).to.equal('');

        controller.dispose();
    });

    it('enforces All-or-Nothing safe delivery across retries in submitSafely', async () => {
        const controller = new HerdrReviewController();
        controller.addComment({
            id: 'c1',
            filePath: 'auth.ts',
            fileName: 'auth.ts',
            startLine: 2,
            endLine: 4,
            codeSnippet: extractSnippetFromFile(path.join(tempRepoDir, 'auth.ts'), 2, 4),
            commentText: 'Ensure user string is trimmed before validation.'
        });

        // First attempt fails (e.g. user cancelled target picker)
        const firstAttempt = await controller.submitSafely(async () => false);
        expect(firstAttempt).to.be.false;
        expect(controller.commentCount).to.equal(1);

        // Second attempt succeeds (e.g. staged or submitted to agent)
        let capturedPayload = '';
        const secondAttempt = await controller.submitSafely(async (payload) => {
            capturedPayload = payload;
            return true;
        }, { branchName: 'main' });

        expect(secondAttempt).to.be.true;
        expect(capturedPayload).to.include('Ensure user string is trimmed before validation.');
        expect(capturedPayload).to.include('throw new Error("Missing user");');
        expect(controller.commentCount).to.equal(0);

        controller.dispose();
    });

    it('lists changed files in repository via HerdrReviewChangesProvider and prepares diff', async () => {
        // Modify auth.ts
        const authFile = path.join(tempRepoDir, 'auth.ts');
        fs.appendFileSync(authFile, '\n// Extra comment line\n');

        // Add untracked new.ts
        const newFile = path.join(tempRepoDir, 'new.ts');
        fs.writeFileSync(newFile, 'console.log("new");\n');

        const provider = new HerdrReviewChangesProvider(async () => tempRepoDir);
        const items = await provider.getChildren();

        expect(items.length).to.equal(2);
        const authItem = items.find(i => i.change.fileName === 'auth.ts');
        const newItem = items.find(i => i.change.fileName === 'new.ts');

        expect(authItem).to.not.be.undefined;
        expect(authItem?.change.status).to.equal('M');
        expect(authItem?.command?.command).to.equal('herdr-collie.openDiff');

        expect(newItem).to.not.be.undefined;
        expect(newItem?.change.status).to.equal('??');

        // Prepare original file for diff
        const originalAuthPath = await prepareOriginalFileForDiff(tempRepoDir, 'auth.ts');
        const originalContent = fs.readFileSync(originalAuthPath, 'utf8');
        expect(originalContent).to.not.include('// Extra comment line');
        expect(originalContent).to.include('export function login');

        provider.dispose();
    });

    it('supports hierarchical compact tree view and toggling to flat view in HerdrReviewChangesProvider', async () => {
        const nestedDir = path.join(tempRepoDir, 'src', 'components', 'buttons');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(path.join(nestedDir, 'PrimaryButton.tsx'), 'export const PrimaryButton = () => null;\n', 'utf8');

        const provider = new HerdrReviewChangesProvider(async () => tempRepoDir, 'tree');
        expect(provider.getViewMode()).to.equal('tree');

        const rootItems = await provider.getChildren();
        expect(rootItems.length).to.equal(1);
        expect(rootItems[0].isFolder).to.be.true;
        expect(rootItems[0].label).to.equal('src/components/buttons');

        const folderChildren = await provider.getChildren(rootItems[0]);
        expect(folderChildren.length).to.equal(1);
        expect(folderChildren[0].isFolder).to.be.false;
        expect(folderChildren[0].change.fileName).to.equal('PrimaryButton.tsx');

        // Toggle to flat mode
        const newMode = provider.toggleViewMode();
        expect(newMode).to.equal('flat');
        const flatItems = await provider.getChildren();
        expect(flatItems.length).to.equal(1);
        expect(flatItems[0].isFolder).to.be.false;
        expect(flatItems[0].change.fileName).to.equal('PrimaryButton.tsx');
        expect(flatItems[0].description).to.include('src/components/buttons');

        provider.dispose();
    });

    it('creates a checkpoint, handles mutations, and rolls back cleanly', async () => {
        // Modify auth.ts before checkpoint
        const authFile = path.join(tempRepoDir, 'auth.ts');
        fs.writeFileSync(authFile, 'initial auth code\n', 'utf8');
        await runGitCmd(['commit', '-am', 'initial code'], tempRepoDir);

        // Create checkpoint
        const cp = await createReviewCheckpoint(tempRepoDir, 'pre-review-test');
        expect(cp).to.not.be.null;
        expect(cp?.id).to.include('checkpoint_');

        // Verify it appears in listReviewCheckpoints
        const checkpoints = await listReviewCheckpoints(tempRepoDir);
        expect(checkpoints.length).to.be.greaterThan(0);
        expect(checkpoints[0].id).to.equal(cp!.id);

        // Mutate working tree (e.g. agent makes bad edits, creates temp files, and developer has .env)
        fs.writeFileSync(authFile, 'corrupted code\n', 'utf8');
        const badFile = path.join(tempRepoDir, 'bad.tmp');
        fs.writeFileSync(badFile, 'temporary garbage\n', 'utf8');
        const envFile = path.join(tempRepoDir, '.env');
        fs.writeFileSync(envFile, 'SECRET_API_KEY=supersecret\n', 'utf8');

        expect(fs.readFileSync(authFile, 'utf8')).to.equal('corrupted code\n');
        expect(fs.existsSync(badFile)).to.be.true;
        expect(fs.existsSync(envFile)).to.be.true;

        // Verify invalid checkpoint ref is rejected
        const invalidSuccess = await rollbackReviewCheckpoint(tempRepoDir, '--dangerous-flag');
        expect(invalidSuccess).to.be.false;

        // Rollback
        const success = await rollbackReviewCheckpoint(tempRepoDir, cp!.hash);
        expect(success).to.be.true;

        // Verify restoration: auth.ts restored, bad.tmp removed, but critical .env preserved
        expect(fs.readFileSync(authFile, 'utf8')).to.equal('initial auth code\n');
        expect(fs.existsSync(badFile)).to.be.false;
        expect(fs.existsSync(envFile)).to.be.true;
        expect(fs.readFileSync(envFile, 'utf8')).to.equal('SECRET_API_KEY=supersecret\n');
    });

    it('prepares delta diff against a specific review checkpoint ref instead of HEAD', async () => {
        const authFile = path.join(tempRepoDir, 'auth.ts');
        // Modify auth.ts to v2 (uncommitted) and create a review checkpoint
        fs.writeFileSync(authFile, 'export const version = "v2-pre-review";\n', 'utf8');
        const cp = await createReviewCheckpoint(tempRepoDir, 'pre-review-submit');
        expect(cp).to.not.be.null;

        const provider = new HerdrReviewChangesProvider(async () => tempRepoDir, 'tree');
        expect(provider.getEffectiveBaseRef()).to.equal('HEAD');

        provider.setBaseCheckpoint(cp!);
        expect(provider.getEffectiveBaseRef()).to.equal(cp!.hash);
        expect(provider.getEffectiveBaseLabel()).to.equal(cp!.id);

        // Agent modifies auth.ts to v3
        fs.writeFileSync(authFile, 'export const version = "v3-post-agent-fix";\n', 'utf8');

        // Diff against checkpoint should return v2-pre-review, whereas diff against HEAD returns original v1
        const checkpointDiffPath = await prepareOriginalFileForDiff(tempRepoDir, 'auth.ts', provider.getEffectiveBaseRef());
        expect(fs.readFileSync(checkpointDiffPath, 'utf8')).to.equal('export const version = "v2-pre-review";\n');

        const headDiffPath = await prepareOriginalFileForDiff(tempRepoDir, 'auth.ts', 'HEAD');
        expect(fs.readFileSync(headDiffPath, 'utf8')).to.include('export function login');

        provider.dispose();
    });

    it('preserves pre-existing untracked files across checkpoint rollback while removing post-checkpoint untracked files', async () => {
        const preExistingUntracked = path.join(tempRepoDir, 'notes.md');
        fs.writeFileSync(preExistingUntracked, 'original untracked notes\n', 'utf8');

        const cp = await createReviewCheckpoint(tempRepoDir, 'with-untracked');
        expect(cp).to.not.be.null;

        // Post-checkpoint mutations: modify pre-existing untracked file and add new garbage file
        fs.writeFileSync(preExistingUntracked, 'corrupted untracked notes\n', 'utf8');
        const garbageFile = path.join(tempRepoDir, 'garbage.tmp');
        fs.writeFileSync(garbageFile, 'should be removed\n', 'utf8');

        const ok = await rollbackReviewCheckpoint(tempRepoDir, cp!.hash);
        expect(ok).to.be.true;

        expect(fs.existsSync(preExistingUntracked)).to.be.true;
        expect(fs.readFileSync(preExistingUntracked, 'utf8')).to.equal('original untracked notes\n');
        expect(fs.existsSync(garbageFile)).to.be.false;

        // Pre-existing untracked file remains untracked (not staged in .git/index)
        const changes = await getRepoChangedFiles(tempRepoDir);
        const notesChange = changes.find(c => c.filePath === 'notes.md');
        expect(notesChange?.status).to.equal('??');
    });

    it('resolves diff targets accurately for renamed (R) and deleted (D) files', async () => {
        // Rename config.ts -> settings.ts (staged so git status reports R)
        const oldPath = path.join(tempRepoDir, 'config.ts');
        const newPath = path.join(tempRepoDir, 'settings.ts');
        fs.renameSync(oldPath, newPath);
        await runGitCmd(['add', '-A'], tempRepoDir);

        // Delete auth.ts from working tree
        fs.unlinkSync(path.join(tempRepoDir, 'auth.ts'));

        const changes = await getRepoChangedFiles(tempRepoDir);
        const renamed = changes.find(c => c.filePath === 'settings.ts');
        const deleted = changes.find(c => c.filePath === 'auth.ts');

        expect(renamed?.status).to.equal('R');
        expect(renamed?.originalFilePath).to.equal('config.ts');
        expect(deleted?.status).to.equal('D');

        const renamedTargets = await resolveDiffTargets(renamed!, tempRepoDir, 'HEAD', 'HEAD');
        expect(fs.readFileSync(renamedTargets.originalPath, 'utf8')).to.include('port: 8080');
        expect(renamedTargets.workingPath).to.equal(renamed!.fullPath);
        expect(renamedTargets.title).to.include('config.ts → settings.ts');

        const deletedTargets = await resolveDiffTargets(deleted!, tempRepoDir, 'HEAD', 'HEAD');
        expect(fs.readFileSync(deletedTargets.originalPath, 'utf8')).to.include('export function login');
        expect(fs.existsSync(deletedTargets.workingPath)).to.be.true;
        expect(fs.readFileSync(deletedTargets.workingPath, 'utf8')).to.equal('');
        expect(deletedTargets.title).to.include('Deleted');
    });

    it('does not resurrect untracked files from an older checkpoint sharing the same HEAD hash', async () => {
        const notesPath = path.join(tempRepoDir, 'notes.md');
        fs.writeFileSync(notesPath, 'first checkpoint untracked\n', 'utf8');

        const cp1 = await createReviewCheckpoint(tempRepoDir, 'cp-one');
        expect(cp1).to.not.be.null;

        // Remove untracked file and create a second checkpoint on the exact same clean HEAD
        fs.unlinkSync(notesPath);
        await new Promise(r => setTimeout(r, 5));
        const cp2 = await createReviewCheckpoint(tempRepoDir, 'cp-two-empty');
        expect(cp2).to.not.be.null;
        expect(cp2!.hash).to.equal(cp1!.hash);

        // Rolling back to cp2 (by hash or ref) must NOT resurrect cp1's notes.md
        fs.writeFileSync(path.join(tempRepoDir, 'extra.tmp'), 'remove me\n', 'utf8');
        const ok2 = await rollbackReviewCheckpoint(tempRepoDir, cp2!.hash);
        expect(ok2).to.be.true;
        expect(fs.existsSync(notesPath)).to.be.false;
        expect(fs.existsSync(path.join(tempRepoDir, 'extra.tmp'))).to.be.false;

        // Rolling back explicitly by cp1 ref still restores cp1's untracked notes.md
        const ok1 = await rollbackReviewCheckpoint(tempRepoDir, `refs/herdr/checkpoints/${cp1!.id}`);
        expect(ok1).to.be.true;
        expect(fs.existsSync(notesPath)).to.be.true;
        expect(fs.readFileSync(notesPath, 'utf8')).to.equal('first checkpoint untracked\n');
    });
});
