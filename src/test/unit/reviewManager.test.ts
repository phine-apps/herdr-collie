/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import '../helpers/mockVscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    detectLanguage,
    extractSnippet,
    formatReviewFeedback,
    HerdrReviewController,
    ReviewCommentItem,
    parseGitStatusPorcelain,
    validateCheckpointRef,
    cleanDiffCache,
    getDiffCacheDir,
    buildReviewChangeTree,
    ReviewFolderTreeItem
} from '../../reviewManager';

describe('reviewManager Unit Tests', () => {
    describe('detectLanguage', () => {
        it('detects common programming and markup languages from extension', () => {
            expect(detectLanguage('src/auth.ts')).to.equal('typescript');
            expect(detectLanguage('components/Button.tsx')).to.equal('tsx');
            expect(detectLanguage('index.js')).to.equal('javascript');
            expect(detectLanguage('app.py')).to.equal('python');
            expect(detectLanguage('main.rs')).to.equal('rust');
            expect(detectLanguage('server.go')).to.equal('go');
            expect(detectLanguage('config.json')).to.equal('json');
            expect(detectLanguage('README.md')).to.equal('markdown');
            expect(detectLanguage('styles.css')).to.equal('css');
            expect(detectLanguage('script.sh')).to.equal('bash');
            expect(detectLanguage('query.sql')).to.equal('sql');
        });

        it('returns text for unknown extensions or extensionless files', () => {
            expect(detectLanguage('Dockerfile')).to.equal('text');
            expect(detectLanguage('LICENSE')).to.equal('text');
            expect(detectLanguage('data.xyz')).to.equal('text');
        });
    });

    describe('extractSnippet', () => {
        const sampleCode = [
            'function add(a: number, b: number): number {',
            '    // Sum two numbers',
            '    const result = a + b;',
            '    return result;',
            '}'
        ].join('\n');

        it('extracts single line snippet correctly (1-based)', () => {
            const snippet = extractSnippet(sampleCode, 3, 3);
            expect(snippet).to.equal('    const result = a + b;');
        });

        it('extracts multi-line snippet correctly', () => {
            const snippet = extractSnippet(sampleCode, 2, 4);
            expect(snippet).to.equal([
                '    // Sum two numbers',
                '    const result = a + b;',
                '    return result;'
            ].join('\n'));
        });

        it('handles out of bounds gracefully', () => {
            expect(extractSnippet(sampleCode, 10, 15)).to.equal('');
            expect(extractSnippet(sampleCode, 4, 2)).to.equal('');
            expect(extractSnippet('', 1, 2)).to.equal('');
        });

        it('truncates snippet when exceeding maxLines', () => {
            const longCode = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
            const snippet = extractSnippet(longCode, 1, 40, 6);
            expect(snippet).to.include('line 1');
            expect(snippet).to.include('line 40');
            expect(snippet).to.include('truncated');
        });
    });

    describe('formatReviewFeedback', () => {
        it('returns empty string when comments list is empty', () => {
            expect(formatReviewFeedback([])).to.equal('');
            expect(formatReviewFeedback(null as any)).to.equal('');
        });

        it('formats structured markdown prompt with single and multi-line comments', () => {
            const comments: ReviewCommentItem[] = [
                {
                    id: 'c1',
                    filePath: 'src/auth.ts',
                    fileName: 'auth.ts',
                    startLine: 45,
                    endLine: 47,
                    codeSnippet: 'if (!user) {\n    throw new Error("404");\n}',
                    commentText: 'Use AuthUserNotFoundError instead of generic Error.'
                },
                {
                    id: 'c2',
                    filePath: 'src/auth.ts',
                    fileName: 'auth.ts',
                    startLine: 12,
                    endLine: 12,
                    commentText: 'Remove unused import.'
                },
                {
                    id: 'c3',
                    filePath: 'src/config.ts',
                    fileName: 'config.ts',
                    startLine: 8,
                    endLine: 8,
                    codeSnippet: 'export const DEBUG = true;',
                    commentText: 'Never hardcode DEBUG to true in production.'
                }
            ];

            const prompt = formatReviewFeedback(comments, {
                agentName: 'claude',
                branchName: 'feat/login-flow',
                customInstruction: 'Make sure all tests in auth.test.ts pass.'
            });

            expect(prompt).to.include('## 🔍 Code Review Feedback to claude');
            expect(prompt).to.include('**Branch / Worktree:** `feat/login-flow`');
            expect(prompt).to.include('### 📄 `src/auth.ts`');
            expect(prompt).to.include('### 📄 `src/config.ts`');
            expect(prompt).to.include('#### 💬 Line 12');
            expect(prompt).to.include('#### 💬 Lines 45-47');
            expect(prompt).to.include('```typescript');
            expect(prompt).to.include('> Use AuthUserNotFoundError instead of generic Error.');
            expect(prompt).to.include('> Remove unused import.');
            expect(prompt).to.include('**Additional Instructions:**');
            expect(prompt).to.include('Make sure all tests in auth.test.ts pass.');
        });

        it('appends Outer-Loop Rule Crystallization section when crystallizeRule is enabled', () => {
            const comments: ReviewCommentItem[] = [
                {
                    id: 'c1',
                    filePath: 'src/executors.ts',
                    fileName: 'executors.ts',
                    startLine: 20,
                    endLine: 20,
                    commentText: 'Always pass arguments as discrete array to execFile instead of shell string interpolation.'
                }
            ];

            const prompt = formatReviewFeedback(comments, {
                agentName: 'claude',
                crystallizeRule: true,
                targetRuleFile: 'AGENTS.md'
            });

            expect(prompt).to.include('### 🔄 Outer-Loop Rule Crystallization (`AGENTS.md`)');
            expect(prompt).to.include('append a concise rule to `AGENTS.md` to prevent recurrence');
        });
    });

    describe('HerdrReviewController', () => {
        it('manages pending comments lifecycle and notifications', () => {
            const controller = new HerdrReviewController();
            expect(controller.commentCount).to.equal(0);
            expect(controller.getPendingComments()).to.deep.equal([]);

            const item1: ReviewCommentItem = {
                id: '1',
                filePath: 'src/app.ts',
                fileName: 'app.ts',
                startLine: 5,
                endLine: 5,
                commentText: 'Fix variable naming.'
            };

            controller.addComment(item1);
            expect(controller.commentCount).to.equal(1);
            expect(controller.getPendingComments()).to.deep.equal([item1]);

            const prompt = controller.formatPrompt();
            expect(prompt).to.include('src/app.ts');
            expect(prompt).to.include('Fix variable naming.');

            controller.removeComment('1');
            expect(controller.commentCount).to.equal(0);

            controller.addComment(item1);
            controller.clearAll();
            expect(controller.commentCount).to.equal(0);

            // Test addCommentFromEditor
            const mockUri = { fsPath: '/path/to/project/src/index.ts' } as any;
            const created = controller.addCommentFromEditor(mockUri, 10, 15, 'Check return type', 'return true;');
            expect(created.fileName).to.equal('index.ts');
            expect(created.startLine).to.equal(10);
            expect(created.endLine).to.equal(15);
            expect(created.commentText).to.equal('Check return type');
            expect(created.codeSnippet).to.equal('return true;');
            expect(controller.commentCount).to.equal(1);

            controller.dispose();
        });

        it('submitSafely preserves comments on cancelled or failed delivery and clears only on success (All-or-Nothing)', async () => {
            const controller = new HerdrReviewController();

            // 1. Empty queue returns false immediately
            let called = false;
            const emptyRes = await controller.submitSafely(async () => {
                called = true;
                return true;
            });
            expect(emptyRes).to.be.false;
            expect(called).to.be.false;

            controller.addComment({
                id: 'c1',
                filePath: 'src/auth.ts',
                fileName: 'auth.ts',
                startLine: 10,
                endLine: 12,
                commentText: 'Validate token expiration.'
            });
            expect(controller.commentCount).to.equal(1);

            // 2. Cancelled delivery (returns false) preserves all comments
            const cancelRes = await controller.submitSafely(async (prompt) => {
                expect(prompt).to.include('Validate token expiration.');
                return false;
            });
            expect(cancelRes).to.be.false;
            expect(controller.commentCount).to.equal(1);

            // 3. Thrown error during delivery preserves all comments
            const errorRes = await controller.submitSafely(async () => {
                throw new Error('Socket disconnected');
            });
            expect(errorRes).to.be.false;
            expect(controller.commentCount).to.equal(1);

            // 4. Successful delivery (returns true) clears all comments
            let deliveredPrompt = '';
            const successRes = await controller.submitSafely(
                async (prompt) => {
                    deliveredPrompt = prompt;
                    return true;
                },
                { branchName: 'feat/safe-review', crystallizeRule: true }
            );
            expect(successRes).to.be.true;
            expect(deliveredPrompt).to.include('feat/safe-review');
            expect(deliveredPrompt).to.include('Outer-Loop Rule Crystallization');
            expect(controller.commentCount).to.equal(0);

            controller.dispose();
        });
    });

    describe('parseGitStatusPorcelain', () => {
        it('parses porcelain status output into structured ChangedFileInfo objects', () => {
            const sampleStatus = [
                ' M src/auth.ts',
                'M  src/user.ts',
                'A  src/newModule.ts',
                '?? src/untracked.ts',
                ' D src/deleted.ts',
                'R  src/old.ts -> src/renamed.ts'
            ].join('\n');

            const result = parseGitStatusPorcelain(sampleStatus, '/repo');
            expect(result).to.have.length(6);

            expect(result[0]).to.deep.include({
                filePath: 'src/auth.ts',
                fileName: 'auth.ts',
                status: 'M',
                statusLabel: 'Modified'
            });

            expect(result[2]).to.deep.include({
                filePath: 'src/newModule.ts',
                fileName: 'newModule.ts',
                status: 'A',
                statusLabel: 'Added'
            });

            expect(result[3]).to.deep.include({
                filePath: 'src/untracked.ts',
                fileName: 'untracked.ts',
                status: '??',
                statusLabel: 'Untracked'
            });

            expect(result[4]).to.deep.include({
                filePath: 'src/deleted.ts',
                fileName: 'deleted.ts',
                status: 'D',
                statusLabel: 'Deleted'
            });

            expect(result[5]).to.deep.include({
                filePath: 'src/renamed.ts',
                fileName: 'renamed.ts',
                status: 'R',
                statusLabel: 'Renamed'
            });
        });

        it('returns empty array on empty or whitespace status output', () => {
            expect(parseGitStatusPorcelain('', '/repo')).to.deep.equal([]);
            expect(parseGitStatusPorcelain('   \n  ', '/repo')).to.deep.equal([]);
        });
    });

    describe('validateCheckpointRef', () => {
        it('accepts valid git commit hashes and ref names', () => {
            expect(validateCheckpointRef('a1b2c3d4e5f6')).to.be.true;
            expect(validateCheckpointRef('refs/herdr/checkpoints/checkpoint_123_test')).to.be.true;
            expect(validateCheckpointRef('HEAD')).to.be.true;
            expect(validateCheckpointRef('main')).to.be.true;
        });

        it('rejects refs starting with a hyphen to prevent option injection', () => {
            expect(validateCheckpointRef('-f')).to.be.false;
            expect(validateCheckpointRef('--ours')).to.be.false;
            expect(validateCheckpointRef('--patch')).to.be.false;
        });

        it('rejects empty, null, or whitespace-only inputs', () => {
            expect(validateCheckpointRef('')).to.be.false;
            expect(validateCheckpointRef('   ')).to.be.false;
            expect(validateCheckpointRef(undefined as any)).to.be.false;
        });

        it('rejects path traversal or invalid characters', () => {
            expect(validateCheckpointRef('../../etc/passwd')).to.be.false;
            expect(validateCheckpointRef('refs/heads//main')).to.be.false;
            expect(validateCheckpointRef('commit; rm -rf /')).to.be.false;
        });
    });

    describe('cleanDiffCache', () => {
        it('cleans files older than maxAgeMs and preserves fresh files', () => {
            const cacheDir = getDiffCacheDir();
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            const oldFile = path.join(cacheDir, `test_old_${Date.now()}.tmp`);
            const newFile = path.join(cacheDir, `test_new_${Date.now()}.tmp`);

            fs.writeFileSync(oldFile, 'old content', 'utf8');
            fs.writeFileSync(newFile, 'new content', 'utf8');

            // Artificially change mtime of oldFile to 2 hours ago
            const twoHoursAgo = (Date.now() - 7200000) / 1000;
            fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

            // Run cleanup with 1 hour threshold (3600000ms)
            cleanDiffCache(3600000);

            expect(fs.existsSync(oldFile)).to.be.false;
            expect(fs.existsSync(newFile)).to.be.true;

            // Clean up newFile
            cleanDiffCache(0);
            expect(fs.existsSync(newFile)).to.be.false;
        });
    });

    describe('formatReviewFeedback (Adversarial Breakout Prevention)', () => {
        it('safely wraps snippets containing triple backticks without breaking markdown fence', () => {
            const comments: ReviewCommentItem[] = [{
                id: 'c1',
                filePath: 'src/exploit.ts',
                fileName: 'exploit.ts',
                startLine: 10,
                endLine: 10,
                commentText: 'Needs refactoring',
                codeSnippet: 'const inject = "```";\nconsole.log(inject);',
                createdAt: Date.now()
            }];

            const feedback = formatReviewFeedback(comments);
            expect(feedback).to.include('````typescript');
            expect(feedback).to.include('const inject = "```";');
        });
    });

    describe('buildReviewChangeTree (Hierarchical & Compact Folders)', () => {
        it('returns empty array when changes list is empty', () => {
            expect(buildReviewChangeTree([], '/repo')).to.deep.equal([]);
        });

        it('compacts single-child folder chains without direct files into a single folder item', () => {
            const changes = parseGitStatusPorcelain([
                ' M src/test/unit/agentHUD.test.ts',
                'A  src/test/unit/l10n.test.ts',
                ' M package.json'
            ].join('\n'), '/repo');

            const tree = buildReviewChangeTree(changes, '/repo');
            // Top level should have 1 compacted folder ('src/test/unit') and 1 root file ('package.json')
            expect(tree).to.have.length(2);

            const folderNode = tree[0] as ReviewFolderTreeItem;
            expect(folderNode).to.be.instanceOf(ReviewFolderTreeItem);
            expect(folderNode.isFolder).to.be.true;
            expect(folderNode.folderLabel).to.equal('src/test/unit');
            expect(folderNode.folderPath).to.equal('src/test/unit');
            expect(folderNode.command).to.be.undefined;
            expect(folderNode.children).to.have.length(2);
            expect(folderNode.children[0].change.fileName).to.equal('agentHUD.test.ts');
            expect(folderNode.children[0].description).to.equal('[Modified]');
            expect(folderNode.children[1].change.fileName).to.equal('l10n.test.ts');
            expect(folderNode.children[1].description).to.equal('[Added]');

            const rootFileNode = tree[1];
            expect(rootFileNode.isFolder).to.be.false;
            expect(rootFileNode.change.fileName).to.equal('package.json');
            expect(rootFileNode.description).to.equal('[Modified]');
        });

        it('preserves parent folder split when folder contains both direct files and nested subfolders', () => {
            const changes = parseGitStatusPorcelain([
                ' M src/extension.ts',
                ' M src/test/unit/reviewManager.test.ts'
            ].join('\n'), '/repo');

            const tree = buildReviewChangeTree(changes, '/repo');
            expect(tree).to.have.length(1);

            const srcFolder = tree[0] as ReviewFolderTreeItem;
            expect(srcFolder.isFolder).to.be.true;
            expect(srcFolder.folderLabel).to.equal('src');
            expect(srcFolder.children).to.have.length(2);

            // Subfolder 'test/unit' should be compacted inside 'src', ordered before file 'extension.ts'
            const nestedFolder = srcFolder.children[0] as ReviewFolderTreeItem;
            expect(nestedFolder.isFolder).to.be.true;
            expect(nestedFolder.folderLabel).to.equal('test/unit');
            expect(nestedFolder.folderPath).to.equal('src/test/unit');
            expect(nestedFolder.children).to.have.length(1);
            expect(nestedFolder.children[0].change.fileName).to.equal('reviewManager.test.ts');

            const directFile = srcFolder.children[1];
            expect(directFile.isFolder).to.be.false;
            expect(directFile.change.fileName).to.equal('extension.ts');
        });
    });
});
