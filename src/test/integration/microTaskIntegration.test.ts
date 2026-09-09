/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import '../helpers/mockVscode';
import { mockState, resetMockState, mockVscode, MockRange } from '../helpers/mockVscode';
import {
    HerdrQuickFixProvider,
    HerdrCodeLensProvider,
    promptAndDispatchTask,
    handleContextTaskDispatch
} from '../../microTaskManager';

describe('Micro-Task CodeLens & Quick-Fix Integration Tests (P4)', () => {
    let tmpDir: string;

    beforeEach(() => {
        resetMockState();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-microtask-test-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    it('QuickFix provider generates actionable CodeActions and dispatches fix to single idle agent', async () => {
        const testFile = path.join(tmpDir, 'service.ts');
        fs.writeFileSync(testFile, 'export function compute(val: string) {\n  return val.toFixed(2);\n}\n', 'utf8');

        let dispatchedTarget = '';
        let dispatchedPrompt = '';

        const fakeSocket: any = {
            isConnected: true,
            getSnapshot: async () => ({
                agents: [
                    { id: 'agent-claude', name: 'claude', status: 'idle' }
                ]
            }),
            sendAgentPrompt: async (target: string, prompt: string) => {
                dispatchedTarget = target;
                dispatchedPrompt = prompt;
                return true;
            }
        };

        const provider = new HerdrQuickFixProvider();
        const doc: any = {
            uri: { fsPath: testFile, path: testFile },
            getText: () => fs.readFileSync(testFile, 'utf8'),
            lineCount: 3
        };

        const diagRange = new MockRange(1, 9, 1, 23);
        const diag: any = {
            message: "Property 'toFixed' does not exist on type 'string'.",
            range: diagRange,
            severity: 0,
            source: 'typescript',
            code: 2339
        };

        const context: any = {
            diagnostics: [diag]
        };

        const actions = provider.provideCodeActions(doc, diagRange as any, context);
        expect(actions.length).to.be.greaterThan(0);
        expect(actions[0].title).to.include('Delegate Fix to Herdr Agent');
        expect(actions[0].command?.command).to.equal('herdr-collie.fixDiagnosticWithAgent');

        // Execute dispatch with the prompt
        const prompt = actions[0].command?.arguments?.[1] ? `Fix issue: ${diag.message}` : '';
        const success = await promptAndDispatchTask(prompt, 'Fix Issue', { socketClient: fakeSocket });

        expect(success).to.be.true;
        expect(dispatchedTarget).to.equal('agent-claude');
        expect(dispatchedPrompt).to.include("Property 'toFixed' does not exist on type 'string'.");
    });

    it('CodeLens provider discovers test blocks and TODO comments and creates executable lenses', () => {
        const testFile = path.join(tmpDir, 'auth.test.ts');
        const content = [
            "describe('UserAuth', () => {",
            "  // TODO: add biometric auth support",
            "  it('validates password credentials', () => {",
            "    expect(true).to.be.true;",
            "  });",
            "});"
        ].join('\n');
        fs.writeFileSync(testFile, content, 'utf8');

        const lines = content.split('\n');
        const doc: any = {
            uri: { fsPath: testFile, path: testFile },
            getText: () => content,
            lineCount: lines.length,
            lineAt: (i: number) => ({ text: lines[i] })
        };

        const codeLensProvider = new HerdrCodeLensProvider();
        const lenses = codeLensProvider.provideCodeLenses(doc, {} as any);

        expect(lenses.length).to.equal(5);

        // Describe suite
        expect(lenses[0].command?.title).to.include('Fix Test with Herdr Agent');
        expect(lenses[0].command?.command).to.equal('herdr-collie.fixTestWithAgent');
        expect(lenses[0].command?.arguments?.[1]).to.equal('UserAuth');

        // TODO item
        expect(lenses[2].command?.title).to.include('Complete TODO with Herdr Agent');
        expect(lenses[2].command?.command).to.equal('herdr-collie.completeTodoWithAgent');
        expect(lenses[2].command?.arguments?.[2]).to.include('add biometric auth support');

        // It test
        expect(lenses[3].command?.title).to.include('Fix Test with Herdr Agent');
        expect(lenses[3].command?.arguments?.[1]).to.equal('validates password credentials');
    });

    it('Keyboard context task dispatch handles diagnostic at cursor position', async () => {
        const testFile = path.join(tmpDir, 'calc.ts');
        const content = 'export function add(a: number, b: number) {\n  return a + b;\n}\nadd("1", 2);\n';
        fs.writeFileSync(testFile, content, 'utf8');

        let dispatchedPrompt = '';
        const fakeSocket: any = {
            isConnected: true,
            getSnapshot: async () => ({
                agents: [{ id: 'agent-idle', name: 'agent-idle', status: 'idle' }]
            }),
            sendAgentPrompt: async (_target: string, prompt: string) => {
                dispatchedPrompt = prompt;
                return true;
            }
        };

        const diagRange = new MockRange(3, 0, 3, 10);
        const diag: any = {
            message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
            range: diagRange,
            severity: 0
        };

        // Mock editor
        const mockEditor: any = {
            document: {
                uri: { fsPath: testFile, path: testFile },
                getText: (range?: any) => range ? 'add("1", 2);' : content,
                lineCount: 4,
                lineAt: (i: number) => ({ text: content.split('\n')[i] })
            },
            selection: {
                active: { line: 3, character: 4 },
                start: { line: 3, character: 0 },
                end: { line: 3, character: 10 },
                isEmpty: true
            }
        };

        // Mock vscode.languages.getDiagnostics
        mockVscode.languages.getDiagnostics = (_uri?: any) => [diag];

        await handleContextTaskDispatch(mockEditor, { socketClient: fakeSocket });
        expect(dispatchedPrompt).to.include('Argument of type \'string\' is not assignable');
        expect(dispatchedPrompt).to.include('calc.ts');
    });
});
