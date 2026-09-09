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

        // Mutate working tree (e.g. agent makes bad edits and creates temp files)
        fs.writeFileSync(authFile, 'corrupted code\n', 'utf8');
        const badFile = path.join(tempRepoDir, 'bad.tmp');
        fs.writeFileSync(badFile, 'temporary garbage\n', 'utf8');

        expect(fs.readFileSync(authFile, 'utf8')).to.equal('corrupted code\n');
        expect(fs.existsSync(badFile)).to.be.true;

        // Rollback
        const success = await rollbackReviewCheckpoint(tempRepoDir, cp!.hash);
        expect(success).to.be.true;

        // Verify restoration
        expect(fs.readFileSync(authFile, 'utf8')).to.equal('initial auth code\n');
        expect(fs.existsSync(badFile)).to.be.false;
    });
});
