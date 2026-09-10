/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as path from 'path';
import '../helpers/mockVscode';
import {
    detectTestAtLine,
    detectTodoAtLine,
    formatDiagnosticPrompt,
    formatTestPrompt,
    formatTodoPrompt,
    formatContextTaskPrompt,
    sortAgentsForDispatch,
    HerdrQuickFixProvider,
    HerdrCodeLensProvider,
    MicroTaskAgentOption,
    promptAndDispatchTask
} from '../../microTaskManager';
import { mockState, resetMockState, mockVscode, MockRange, MockPosition } from '../helpers/mockVscode';

describe('microTaskManager Unit Tests', () => {
    beforeEach(() => {
        resetMockState();
    });

    describe('detectTestAtLine', () => {
        it('detects JavaScript / TypeScript it and test functions', () => {
            const itResult = detectTestAtLine("  it('validates user authentication', () => {");
            expect(itResult).to.deep.equal({
                isTest: true,
                testName: 'validates user authentication',
                isSuite: false
            });

            const itOnlyResult = detectTestAtLine('  it.only("handles token refresh", async () => {');
            expect(itOnlyResult).to.deep.equal({
                isTest: true,
                testName: 'handles token refresh',
                isSuite: false
            });

            const testResult = detectTestAtLine("test('calculates sum properly', () => {");
            expect(testResult).to.deep.equal({
                isTest: true,
                testName: 'calculates sum properly',
                isSuite: false
            });
        });

        it('detects JavaScript / TypeScript describe and suite blocks', () => {
            const descResult = detectTestAtLine("describe('AuthService', () => {");
            expect(descResult).to.deep.equal({
                isTest: true,
                testName: 'AuthService',
                isSuite: true
            });

            const suiteResult = detectTestAtLine("suite('DatabasePool', () => {");
            expect(suiteResult).to.deep.equal({
                isTest: true,
                testName: 'DatabasePool',
                isSuite: true
            });
        });

        it('detects Python test functions and Test classes', () => {
            const pyFn = detectTestAtLine('def test_jwt_expiry(self):');
            expect(pyFn).to.deep.equal({
                isTest: true,
                testName: 'test_jwt_expiry',
                isSuite: false
            });

            const pyClass = detectTestAtLine('class TestPaymentGateway(unittest.TestCase):');
            expect(pyClass).to.deep.equal({
                isTest: true,
                testName: 'TestPaymentGateway',
                isSuite: true
            });
        });

        it('detects Go Test and Benchmark functions', () => {
            const goTest = detectTestAtLine('func TestRouter(t *testing.T) {');
            expect(goTest).to.deep.equal({
                isTest: true,
                testName: 'TestRouter',
                isSuite: false
            });

            const goBench = detectTestAtLine('func BenchmarkSerialization(b *testing.B) {');
            expect(goBench).to.deep.equal({
                isTest: true,
                testName: 'BenchmarkSerialization',
                isSuite: false
            });
        });

        it('detects Rust test functions preceded by #[test]', () => {
            const rustTest = detectTestAtLine('fn test_cache_invalidation() {', '#[test]');
            expect(rustTest).to.deep.equal({
                isTest: true,
                testName: 'test_cache_invalidation',
                isSuite: false
            });

            const asyncRustTest = detectTestAtLine('async fn test_network_retry() {', '#[tokio::test]');
            expect(asyncRustTest).to.deep.equal({
                isTest: true,
                testName: 'test_network_retry',
                isSuite: false
            });
        });

        it('returns null for non-test code lines', () => {
            expect(detectTestAtLine('const x = 42;')).to.be.null;
            expect(detectTestAtLine('function calculateTotal(price: number) {')).to.be.null;
            expect(detectTestAtLine('// it should not match comments')).to.be.null;
            expect(detectTestAtLine('')).to.be.null;
        });
    });

    describe('detectTodoAtLine', () => {
        it('detects // TODO: comments with or without tags', () => {
            const simple = detectTodoAtLine('// TODO: implement OAuth2 redirect flow');
            expect(simple).to.deep.equal({
                isTodo: true,
                type: 'TODO',
                text: 'implement OAuth2 redirect flow',
                tag: undefined
            });

            const tagged = detectTodoAtLine('// TODO(auth): add rate limiting for failed logins');
            expect(tagged).to.deep.equal({
                isTodo: true,
                type: 'TODO',
                text: 'add rate limiting for failed logins',
                tag: 'auth'
            });
        });

        it('detects FIXME comments across Python, Shell, and C-style comments', () => {
            const pyFixme = detectTodoAtLine('# FIXME: handle NoneType exception on empty payload');
            expect(pyFixme).to.deep.equal({
                isTodo: true,
                type: 'FIXME',
                text: 'handle NoneType exception on empty payload',
                tag: undefined
            });

            const blockFixme = detectTodoAtLine('/* FIXME(perf): optimize database join */');
            expect(blockFixme).to.deep.equal({
                isTodo: true,
                type: 'FIXME',
                text: 'optimize database join',
                tag: 'perf'
            });
        });

        it('detects and trims HTML comment closures including --> and --!>', () => {
            const htmlTodo = detectTodoAtLine('<!-- TODO: add accessibility ARIA attributes -->');
            expect(htmlTodo).to.deep.equal({
                isTodo: true,
                type: 'TODO',
                text: 'add accessibility ARIA attributes',
                tag: undefined
            });

            const htmlBangTodo = detectTodoAtLine('<!-- TODO: support legacy parser --!>');
            expect(htmlBangTodo).to.deep.equal({
                isTodo: true,
                type: 'TODO',
                text: 'support legacy parser',
                tag: undefined
            });
        });

        it('returns null for regular lines without TODO or FIXME', () => {
            expect(detectTodoAtLine('const total = price * 1.1;')).to.be.null;
            expect(detectTodoAtLine('// This is just a regular comment')).to.be.null;
            expect(detectTodoAtLine('')).to.be.null;
        });
    });

    describe('Prompt Formatters', () => {
        it('formatDiagnosticPrompt formats structured Markdown with code snippet and diagnostic details', () => {
            const prompt = formatDiagnosticPrompt(
                'src/auth.ts',
                42,
                {
                    message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
                    source: 'typescript',
                    code: 2345,
                    severity: 'Error'
                },
                '40: function add(a: number, b: number) {\n41:   return a + b;\n42: }\n43: add("1", 2);'
            );

            expect(prompt).to.include('`src/auth.ts` (Line 42)');
            expect(prompt).to.include('- **Severity:** Error');
            expect(prompt).to.include('`typescript / 2345`');
            expect(prompt).to.include("Argument of type 'string' is not assignable");
            expect(prompt).to.include('```typescript');
            expect(prompt).to.include('add("1", 2);');
        });

        it('formatTestPrompt formats fix and edge-cases prompts', () => {
            const fixPrompt = formatTestPrompt(
                'test/auth.test.ts',
                'verifies password hash',
                15,
                'it("verifies password hash", () => {\n  expect(hash("pass")).to.be.ok;\n});',
                'fix'
            );
            expect(fixPrompt).to.include('fix failing test "verifies password hash"');
            expect(fixPrompt).to.include('`test/auth.test.ts` (Line 15)');

            const edgePrompt = formatTestPrompt(
                'test/auth.test.ts',
                'verifies password hash',
                15,
                'it("verifies password hash", () => {\n  expect(hash("pass")).to.be.ok;\n});',
                'edge-cases'
            );
            expect(edgePrompt).to.include('generate additional edge-case tests for "verifies password hash"');
        });

        it('formatTodoPrompt formats task completion prompt with context', () => {
            const prompt = formatTodoPrompt(
                'src/cache.ts',
                'TODO',
                'add Redis cluster support',
                28,
                '// TODO: add Redis cluster support\nconst client = new Redis();'
            );
            expect(prompt).to.include('Please complete the following TODO');
            expect(prompt).to.include('> **TODO**: add Redis cluster support');
            expect(prompt).to.include('`src/cache.ts` (Line 28)');
        });

        it('formatContextTaskPrompt formats custom instruction prompt', () => {
            const prompt = formatContextTaskPrompt(
                'src/utils.ts',
                10,
                'Refactor to use reduce instead of for loop',
                'let sum = 0;\nfor (const n of numbers) sum += n;'
            );
            expect(prompt).to.include('`src/utils.ts` (around Line 10)');
            expect(prompt).to.include('**Instruction:** Refactor to use reduce instead of for loop');
        });

        it('prevents markdown code fence breakout when snippets contain triple backticks', () => {
            const maliciousSnippet = 'const a = "```";\nconsole.log(a);';
            const diagPrompt = formatDiagnosticPrompt(
                'src/exploit.ts',
                5,
                { message: 'Inject error', severity: 'Error' },
                maliciousSnippet
            );
            expect(diagPrompt).to.include('````typescript\nconst a = "```";');

            const taskPrompt = formatContextTaskPrompt(
                'src/exploit.ts',
                5,
                'Fix this snippet',
                maliciousSnippet
            );
            expect(taskPrompt).to.include('````typescript\nconst a = "```";');
        });
    });

    describe('sortAgentsForDispatch', () => {
        it('prioritizes idle agents first, followed by waiting, then working, then other', () => {
            const agents: MicroTaskAgentOption[] = [
                { id: '1', name: 'agent-busy', status: 'processing', statusType: 'working' },
                { id: '2', name: 'agent-idle-b', status: 'idle', statusType: 'idle' },
                { id: '3', name: 'agent-waiting', status: 'waiting for approval', statusType: 'waiting' },
                { id: '4', name: 'agent-idle-a', status: 'idle', statusType: 'idle' },
                { id: '5', name: 'agent-unknown', status: 'exited', statusType: 'other' }
            ];

            const sorted = sortAgentsForDispatch(agents);
            expect(sorted.map(a => a.id)).to.deep.equal(['4', '2', '3', '1', '5']);
        });
    });

    describe('HerdrQuickFixProvider', () => {
        const provider = new HerdrQuickFixProvider();

        const fakeDoc: any = {
            uri: { fsPath: '/app/src/index.ts', path: '/app/src/index.ts' },
            getText: () => 'const x: number = "test";'
        };

        it('returns empty array when context has no diagnostics', () => {
            const range = new MockRange(0, 0, 0, 10);
            const context: any = { diagnostics: [] };
            const actions = provider.provideCodeActions(fakeDoc, range as any, context);
            expect(actions).to.be.an('array').that.is.empty;
        });

        it('provides primary Quick-Fix action when diagnostic is present', () => {
            const range = new MockRange(0, 0, 0, 10);
            const diag: any = {
                message: "Type 'string' is not assignable to type 'number'.",
                range
            };
            const context: any = { diagnostics: [diag] };
            const actions = provider.provideCodeActions(fakeDoc, range as any, context);

            expect(actions.length).to.equal(1);
            expect(actions[0].title).to.include('Delegate Fix to Herdr Agent');
            expect(actions[0].isPreferred).to.be.true;
            expect(actions[0].command?.command).to.equal('herdr-collie.fixDiagnosticWithAgent');
            expect(actions[0].command?.arguments?.[1]).to.equal(diag);
        });

        it('provides both single and all-issues Quick-Fix actions when multiple diagnostics exist', () => {
            const range = new MockRange(0, 0, 0, 10);
            const diag1: any = { message: "Error 1", range };
            const diag2: any = { message: "Error 2", range };
            const context: any = { diagnostics: [diag1, diag2] };
            const actions = provider.provideCodeActions(fakeDoc, range as any, context);

            expect(actions.length).to.equal(2);
            expect(actions[0].title).to.include('Delegate Fix to Herdr Agent');
            expect(actions[1].title).to.include('Delegate All Issues on Line to Herdr Agent');
            expect(actions[1].command?.arguments?.[1]).to.deep.equal([diag1, diag2]);
        });
    });

    describe('HerdrCodeLensProvider', () => {
        const provider = new HerdrCodeLensProvider();

        it('generates test and edge-case CodeLenses on test lines, and TODO CodeLenses on TODO lines', () => {
            const lines = [
                "describe('AuthModule', () => {",
                "  // TODO: implement OAuth2",
                "  it('authenticates user', () => {",
                "    expect(true).to.be.true;",
                "  });",
                "});"
            ];

            const fakeDoc: any = {
                uri: { fsPath: '/app/src/auth.test.ts', path: '/app/src/auth.test.ts' },
                lineCount: lines.length,
                lineAt: (i: number) => ({ text: lines[i] })
            };

            const lenses = provider.provideCodeLenses(fakeDoc, {} as any);
            expect(lenses).to.be.an('array');

            // describe -> 2 lenses (fix + edge cases)
            // TODO -> 1 lens
            // it -> 2 lenses (fix + edge cases)
            // Total = 5
            expect(lenses.length).to.equal(5);

            expect(lenses[0].command?.title).to.include('Fix Test with Herdr Agent');
            expect(lenses[1].command?.title).to.include('Generate Edge Cases with Herdr Agent');
            expect(lenses[2].command?.title).to.include('Complete TODO with Herdr Agent');
            expect(lenses[3].command?.title).to.include('Fix Test with Herdr Agent');
            expect(lenses[4].command?.title).to.include('Generate Edge Cases with Herdr Agent');
        });

        it('returns empty array when codeLens.enable is set to false', () => {
            mockState.configurations.set('herdr-collie.codeLens.enable', false);
            const fakeDoc: any = {
                uri: { fsPath: '/app/src/auth.test.ts', path: '/app/src/auth.test.ts' },
                lineCount: 1,
                lineAt: () => ({ text: "it('test', () => {})" })
            };
            const lenses = provider.provideCodeLenses(fakeDoc, {} as any);
            expect(lenses).to.be.empty;
        });
    });

    describe('promptAndDispatchTask', () => {
        it('prompts to launch agent when no agents are running', async () => {
            mockState.warningMessageResponse = undefined;

            const fakeSocket: any = {
                isConnected: true,
                getSnapshot: async () => ({ agents: [] })
            };

            const dispatched = await promptAndDispatchTask('Fix bug', 'Fix Bug', { socketClient: fakeSocket });
            expect(dispatched).to.be.false;
            expect(mockState.lastWarningMessage?.message).to.include('No active Herdr agents found');
        });

        it('auto-dispatches directly without QuickPick when exactly 1 agent is active', async () => {
            let sentPrompt = '';
            let sentTarget = '';

            const fakeSocket: any = {
                isConnected: true,
                getSnapshot: async () => ({
                    agents: [{ id: 'agent-1', name: 'claude-1', status: 'idle' }]
                }),
                sendAgentPrompt: async (target: string, prompt: string) => {
                    sentTarget = target;
                    sentPrompt = prompt;
                    return true;
                }
            };

            const dispatched = await promptAndDispatchTask('Please fix this test', 'Fix Test', { socketClient: fakeSocket });
            expect(dispatched).to.be.true;
            expect(sentTarget).to.equal('agent-1');
            expect(sentPrompt).to.equal('Please fix this test');
            expect(mockState.lastInformationMessage?.message).to.include("Dispatched task to 'claude-1'");
        });
    });
});
