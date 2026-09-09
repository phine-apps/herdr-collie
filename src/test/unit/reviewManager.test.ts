/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import '../helpers/mockVscode';
import {
    detectLanguage,
    extractSnippet,
    formatReviewFeedback,
    HerdrReviewController,
    ReviewCommentItem,
    parseGitStatusPorcelain
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
});
