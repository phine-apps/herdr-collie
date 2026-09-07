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
    formatGitDiff,
    formatBranchContext,
    formatSelectionContext,
    formatWorkspaceProblems,
    formatTerminalOutput
} from '../../formatters';

describe('Context Sharing & SCM Integration Tests (C-01 ~ C-07, A-03, A-04)', function() {
    this.timeout(10000);

    let tempRepoDir: string;

    beforeEach(async () => {
        tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-ctx-int-'));

        await runGitCmd(['init', '-b', 'main'], tempRepoDir);
        await runGitCmd(['config', 'user.name', 'Context Tester'], tempRepoDir);
        await runGitCmd(['config', 'user.email', 'context@example.com'], tempRepoDir);

        const initialFile = path.join(tempRepoDir, 'app.ts');
        fs.writeFileSync(initialFile, 'export function add(a: number, b: number) {\n    return a + b;\n}\n', 'utf8');
        await runGitCmd(['add', 'app.ts'], tempRepoDir);
        await runGitCmd(['commit', '-m', 'feat: initial math module'], tempRepoDir);
    });

    afterEach(() => {
        try {
            fs.rmSync(tempRepoDir, { recursive: true, force: true });
        } catch (e) {}
    });

    describe('Git Staged and Working Tree Diff Extraction (C-05, C-06)', () => {
        it('extracts and formats staged git diff accurately', async () => {
            const filePath = path.join(tempRepoDir, 'app.ts');
            fs.writeFileSync(filePath, 'export function add(a: number, b: number) {\n    // Added comment\n    return a + b;\n}\n', 'utf8');

            await runGitCmd(['add', 'app.ts'], tempRepoDir);

            const stdout = await runGitCmd(['diff', '--cached'], tempRepoDir);
            expect(stdout).to.include('+    // Added comment');

            const formatted = formatGitDiff(stdout, 'app.ts', true);
            expect(formatted).to.include('Here is the staged git diff for `app.ts`:');
            expect(formatted).to.include('```diff');
            expect(formatted).to.include('+    // Added comment');
            expect(formatted).to.include('Please review these staged changes.');
        });

        it('extracts and formats working tree (unstaged) git diff accurately', async () => {
            const filePath = path.join(tempRepoDir, 'app.ts');
            fs.writeFileSync(filePath, 'export function add(a: number, b: number) {\n    return a + b * 2;\n}\n', 'utf8');

            const stdout = await runGitCmd(['diff'], tempRepoDir);
            expect(stdout).to.include('+    return a + b * 2;');

            const formatted = formatGitDiff(stdout, '', false);
            expect(formatted).to.include('Here is the working tree (unstaged) git diff:');
            expect(formatted).to.include('```diff');
            expect(formatted).to.include('+    return a + b * 2;');
            expect(formatted).to.include('Please review these changes.');
        });

        it('safely truncates massive git diffs exceeding character threshold (A-04)', () => {
            const massiveDiff = 'a'.repeat(60000);
            const formatted = formatGitDiff(massiveDiff, 'large.ts', true);
            expect(formatted).to.include('... (truncated)');
            expect(formatted.length).to.be.lessThan(55000);
        });
    });

    describe('Branch Context and Divergent History Extraction (C-07)', () => {
        it('extracts branch name and log commits since divergence from main', async () => {
            // Create and checkout feature branch
            await runGitCmd(['checkout', '-b', 'feature/new-calc'], tempRepoDir);

            const calcFile = path.join(tempRepoDir, 'calc.ts');
            fs.writeFileSync(calcFile, 'export const PI = 3.14159;\n', 'utf8');
            await runGitCmd(['add', 'calc.ts'], tempRepoDir);
            await runGitCmd(['commit', '-m', 'feat: add PI constant'], tempRepoDir);

            const logStdout = await runGitCmd(['log', 'main..HEAD', '--oneline'], tempRepoDir);
            expect(logStdout).to.include('feat: add PI constant');

            const formatted = formatBranchContext('feature/new-calc', logStdout);
            expect(formatted).to.include('**Current Branch:** `feature/new-calc`');
            expect(formatted).to.include('feat: add PI constant');
        });
    });

    describe('Code Selection, Diagnostic, and Terminal Context Formatting (C-01, C-03, C-08)', () => {
        it('formats multi-line code selection with line numbers and language tag', () => {
            const snippet = 'const x = 10;\nconst y = 20;';
            const formatted = formatSelectionContext('src/calc.ts', 12, 13, 'typescript', snippet);

            expect(formatted).to.include('`src/calc.ts` (Lines 12-13):');
            expect(formatted).to.include('```typescript');
            expect(formatted).to.include('const x = 10;');
        });

        it('formats grouped workspace problems across multiple files', () => {
            const problems = {
                'src/auth.ts': [
                    { line: 15, severity: 'Error' as const, message: 'Cannot find name jwt' }
                ],
                'src/user.ts': [
                    { line: 30, severity: 'Warning' as const, message: 'Unused variable id' }
                ]
            };

            const formatted = formatWorkspaceProblems(problems);
            expect(formatted).to.include('### `src/auth.ts`');
            expect(formatted).to.include('- **Line 15** [Error]: Cannot find name jwt');
            expect(formatted).to.include('### `src/user.ts`');
            expect(formatted).to.include('- **Line 30** [Warning]: Unused variable id');
        });

        it('formats terminal output and truncates long buffer outputs (A-04)', () => {
            const normalOutput = 'npm test\nPASS 10 tests';
            const formatted = formatTerminalOutput('zsh', normalOutput);
            expect(formatted).to.include('Here is the terminal output from `zsh`:');
            expect(formatted).to.include('PASS 10 tests');

            const hugeOutput = 'line\n'.repeat(15000);
            const truncated = formatTerminalOutput('zsh', hugeOutput);
            expect(truncated).to.include('... (truncated)');
            expect(truncated.length).to.be.lessThan(55000);
        });
    });
});
