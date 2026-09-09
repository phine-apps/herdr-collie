/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { detectLanguage, extractSnippet } from './reviewManager';
import { HerdrSocketClient } from './socketClient';
import { parseSnapshotAgents, parseSnapshotWorkspaces, parseAgents } from './parsers';
import { execHerdr } from './executors';

export interface MicroTaskDiagnostic {
    message: string;
    code?: string | number;
    source?: string;
    severity?: string;
    line: number;
    range?: vscode.Range;
}

export interface MicroTaskAgentOption {
    id: string;
    name: string;
    status: string;
    statusType: 'idle' | 'waiting' | 'working' | 'other';
    workspaceLabel?: string;
    cwd?: string;
}

export interface TestDetectionResult {
    isTest: boolean;
    testName: string;
    isSuite: boolean;
}

export interface TodoDetectionResult {
    isTodo: boolean;
    type: 'TODO' | 'FIXME';
    text: string;
    tag?: string;
}

/**
 * Detects whether a line declares a test or test suite across TS/JS, Python, Rust, and Go.
 */
export function detectTestAtLine(lineText: string, prevLineText?: string): TestDetectionResult | null {
    const trimmed = lineText.trim();
    if (!trimmed) return null;

    // JavaScript / TypeScript: it('...'), test('...'), describe('...'), suite('...')
    const jsTestMatch = trimmed.match(/^(?:(?:async\s+)?it|test)(?:\.(?:only|skip))?\s*\(\s*(['"`])(.*?)\1/);
    if (jsTestMatch) {
        return { isTest: true, testName: jsTestMatch[2], isSuite: false };
    }

    const jsSuiteMatch = trimmed.match(/^(?:describe|suite)(?:\.(?:only|skip))?\s*\(\s*(['"`])(.*?)\1/);
    if (jsSuiteMatch) {
        return { isTest: true, testName: jsSuiteMatch[2], isSuite: true };
    }

    // Python: def test_*(...) or class Test*(...)
    const pyTestMatch = trimmed.match(/^def\s+(test_\w+)\s*\(/);
    if (pyTestMatch) {
        return { isTest: true, testName: pyTestMatch[1], isSuite: false };
    }
    const pyClassMatch = trimmed.match(/^class\s+(Test\w+)/);
    if (pyClassMatch) {
        return { isTest: true, testName: pyClassMatch[1], isSuite: true };
    }

    // Go: func Test*(...) or func Benchmark*(...)
    const goTestMatch = trimmed.match(/^func\s+(Test\w+|Benchmark\w+)\s*\(/);
    if (goTestMatch) {
        return { isTest: true, testName: goTestMatch[1], isSuite: false };
    }

    // Rust: #[test] or #[tokio::test] on previous line or same line
    const rustFnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/);
    if (rustFnMatch && prevLineText) {
        const prevTrimmed = prevLineText.trim();
        if (/#\[(?:tokio::)?test\]/.test(prevTrimmed)) {
            return { isTest: true, testName: rustFnMatch[1], isSuite: false };
        }
    }
    if (trimmed.startsWith('#[test]') || trimmed.startsWith('#[tokio::test]')) {
        return { isTest: true, testName: 'test', isSuite: false };
    }

    return null;
}

/**
 * Detects TODO or FIXME comment in a line of code.
 */
export function detectTodoAtLine(lineText: string): TodoDetectionResult | null {
    const match = lineText.match(/(?:\/\/|#|\/\*|<!--)\s*(TODO|FIXME)(?:\(([^)]+)\))?:\s*(.+)$/i);
    if (!match) return null;

    const rawType = match[1].toUpperCase();
    const type: 'TODO' | 'FIXME' = rawType === 'FIXME' ? 'FIXME' : 'TODO';
    const tag = match[2]?.trim();
    let text = match[3]?.trim() || '';
    // Strip trailing comment closures like */ or -->
    text = text.replace(/(?:\*\/|-->)\s*$/, '').trim();

    return {
        isTodo: true,
        type,
        text,
        tag
    };
}

/**
 * Formats structured prompt for fixing compiler/linter diagnostic
 */
export function formatDiagnosticPrompt(
    fileRelPath: string,
    line: number,
    diagnostic: { message: string; code?: string | number | { value: string | number; target?: any }; source?: string; severity?: string | vscode.DiagnosticSeverity | number },
    codeSnippet: string
): string {
    const lang = detectLanguage(fileRelPath);
    const codeVal = typeof diagnostic.code === 'object' && diagnostic.code !== null ? diagnostic.code.value : diagnostic.code;
    const sourceInfo = [diagnostic.source, codeVal].filter(Boolean).join(' / ');
    const sourceLine = sourceInfo ? `- **Source / Code:** \`${sourceInfo}\`\n` : '';
    
    let severityStr = 'Error';
    if (typeof diagnostic.severity === 'number') {
        switch (diagnostic.severity) {
            case 0: severityStr = 'Error'; break;
            case 1: severityStr = 'Warning'; break;
            case 2: severityStr = 'Information'; break;
            case 3: severityStr = 'Hint'; break;
            default: severityStr = 'Error'; break;
        }
    } else if (typeof diagnostic.severity === 'string' && diagnostic.severity) {
        severityStr = diagnostic.severity;
    }

    return [
        `Please fix the following issue detected in \`${fileRelPath}\` (Line ${line}):`,
        '',
        `- **Severity:** ${severityStr}`,
        sourceLine.trim(),
        `- **Message:** ${diagnostic.message}`,
        '',
        '**Surrounding Code:**',
        `\`\`\`${lang}`,
        codeSnippet,
        `\`\`\``,
        '',
        `Please analyze this error and implement the fix directly in \`${fileRelPath}\`.`
    ].filter(line => line !== undefined && line !== '').join('\n');
}

/**
 * Formats structured prompt for fixing or generating edge cases for a test
 */
export function formatTestPrompt(
    fileRelPath: string,
    testName: string,
    line: number,
    codeSnippet: string,
    mode: 'fix' | 'edge-cases'
): string {
    const lang = detectLanguage(fileRelPath);
    if (mode === 'fix') {
        return [
            `Please help me fix failing test "${testName}" in \`${fileRelPath}\` (Line ${line}):`,
            '',
            '**Test Implementation:**',
            `\`\`\`${lang}`,
            codeSnippet,
            `\`\`\``,
            '',
            `Please inspect the test logic, identify why it might fail, and propose or implement the fix in \`${fileRelPath}\`.`
        ].join('\n');
    }

    return [
        `Please help me generate additional edge-case tests for "${testName}" in \`${fileRelPath}\` (Line ${line}):`,
        '',
        '**Target Test / Suite:**',
        `\`\`\`${lang}`,
        codeSnippet,
        `\`\`\``,
        '',
        `Please analyze the inputs and assertions, and generate comprehensive edge-case tests (e.g. boundary conditions, invalid inputs, error handling) in \`${fileRelPath}\`.`
    ].join('\n');
}

/**
 * Formats structured prompt for completing a TODO/FIXME comment
 */
export function formatTodoPrompt(
    fileRelPath: string,
    todoType: string,
    todoText: string,
    line: number,
    codeSnippet: string
): string {
    const lang = detectLanguage(fileRelPath);
    return [
        `Please complete the following ${todoType} found in \`${fileRelPath}\` (Line ${line}):`,
        '',
        `> **${todoType}**: ${todoText}`,
        '',
        '**Surrounding Context:**',
        `\`\`\`${lang}`,
        codeSnippet,
        `\`\`\``,
        '',
        `Please implement this task directly in \`${fileRelPath}\`.`
    ].join('\n');
}

/**
 * Formats structured prompt for context tasks (refactor, test generation, custom instruction)
 */
export function formatContextTaskPrompt(
    fileRelPath: string,
    line: number,
    instruction: string,
    codeSnippet: string
): string {
    const lang = detectLanguage(fileRelPath);
    return [
        `Regarding \`${fileRelPath}\` (around Line ${line}):`,
        '',
        `**Instruction:** ${instruction}`,
        '',
        '**Target Code:**',
        `\`\`\`${lang}`,
        codeSnippet,
        `\`\`\``,
        '',
        `Please implement the requested changes.`
    ].join('\n');
}

/**
 * Sorts agents prioritizing idle agents first, followed by waiting, working, then others
 */
export function sortAgentsForDispatch(agents: MicroTaskAgentOption[]): MicroTaskAgentOption[] {
    const priorityWeight: Record<MicroTaskAgentOption['statusType'], number> = {
        idle: 0,
        waiting: 1,
        working: 2,
        other: 3
    };

    return [...agents].sort((a, b) => {
        const diff = (priorityWeight[a.statusType] ?? 3) - (priorityWeight[b.statusType] ?? 3);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name);
    });
}

/**
 * Discovers available agents from socket client snapshot or CLI fallback
 */
export async function getAvailableAgents(
    socketClient?: HerdrSocketClient,
    sessionName: string = 'vscode'
): Promise<MicroTaskAgentOption[]> {
    if (socketClient && socketClient.isConnected) {
        try {
            const snapshot = await socketClient.getSnapshot();
            if (snapshot) {
                const workspaces = parseSnapshotWorkspaces(snapshot);
                const agents = parseSnapshotAgents(snapshot, workspaces);
                return (agents || []).map(a => {
                    let statusType: MicroTaskAgentOption['statusType'] = 'other';
                    const st = (a.status || '').toLowerCase();
                    if (a.statusType === 'done' || st.includes('idle') || st.includes('ready') || st.includes('done')) {
                        statusType = 'idle';
                    } else if (a.statusType === 'blocked' || st.includes('wait') || st.includes('input') || st.includes('blocked')) {
                        statusType = 'waiting';
                    } else if (a.statusType === 'working' || st.includes('work') || st.includes('busy')) {
                        statusType = 'working';
                    }
                    return {
                        id: a.id,
                        name: a.name || a.id,
                        status: a.status || 'unknown',
                        statusType,
                        workspaceLabel: a.workspaceLabel,
                        cwd: a.workspaceCwd
                    };
                });
            }
        } catch {
            // Fall back to CLI
        }
    }

    return new Promise<MicroTaskAgentOption[]>((resolve) => {
        execHerdr(['--session', sessionName, 'agent', 'list'], (err: any, stdout: any) => {
            if (!err && stdout) {
                const parsed = parseAgents(stdout);
                const list: MicroTaskAgentOption[] = parsed.map(a => {
                    let statusType: MicroTaskAgentOption['statusType'] = 'other';
                    const st = (a.status || '').toLowerCase();
                    if (st.includes('idle') || st.includes('ready') || st.includes('done')) {
                        statusType = 'idle';
                    } else if (st.includes('wait') || st.includes('input') || st.includes('confirm') || st.includes('block')) {
                        statusType = 'waiting';
                    } else if (st.includes('work') || st.includes('busy') || st.includes('run')) {
                        statusType = 'working';
                    }
                    return {
                        id: a.id,
                        name: a.name || a.id,
                        status: a.status || 'unknown',
                        statusType,
                        workspaceLabel: a.workspaceLabel,
                        cwd: undefined
                    };
                });
                resolve(list);
            } else {
                resolve([]);
            }
        });
    });
}

/**
 * Dispatches a prompt string to an agent via socket or CLI fallback
 */
export async function sendPromptToAgent(
    agentId: string,
    prompt: string,
    options?: { socketClient?: HerdrSocketClient; sessionName?: string; cwd?: string }
): Promise<boolean> {
    const socket = options?.socketClient;
    const sessionName = options?.sessionName || 'vscode';
    const cwd = options?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (socket && socket.isConnected) {
        try {
            await socket.sendAgentPrompt(agentId, prompt);
            return true;
        } catch {
            // Fall back to CLI
        }
    }

    return new Promise<boolean>((resolve) => {
        const sessionArgs = sessionName ? ['--session', sessionName] : [];
        execHerdr([...sessionArgs, 'agent', 'prompt', agentId, prompt], { cwd }, (err: any) => {
            if (err) {
                // If agent prompt fails with agent_not_found, try pane send-text
                execHerdr([...sessionArgs, 'pane', 'send-text', agentId, prompt], { cwd }, (fbErr: any) => {
                    resolve(!fbErr);
                });
            } else {
                resolve(true);
            }
        });
    });
}

/**
 * Intelligent dispatch orchestrator:
 * - 0 agents: prompt to launch one
 * - 1 agent: auto-dispatch instantly without popup
 * - 2+ agents: QuickPick with idle agents sorted first
 */
export async function promptAndDispatchTask(
    prompt: string,
    taskTitle: string,
    options?: { socketClient?: HerdrSocketClient; sessionName?: string; cwd?: string }
): Promise<boolean> {
    const sessionName = options?.sessionName || 'vscode';
    const rawAgents = await getAvailableAgents(options?.socketClient, sessionName);

    if (rawAgents.length === 0) {
        const launchAction = l10n.t('Launch Agent in Git Worktree...');
        const choice = await vscode.window.showWarningMessage(
            l10n.t('No active Herdr agents found to receive task.'),
            launchAction
        );
        if (choice === launchAction) {
            vscode.commands.executeCommand('herdr-collie.launchWorktreeAgent');
        }
        return false;
    }

    const sorted = sortAgentsForDispatch(rawAgents);

    // If exactly 1 agent is active, auto-dispatch without prompting!
    if (sorted.length === 1) {
        const singleAgent = sorted[0];
        const success = await sendPromptToAgent(singleAgent.id, prompt, options);
        if (success) {
            vscode.window.showInformationMessage(l10n.t("Dispatched task to '{0}'", singleAgent.name));
        } else {
            vscode.window.showErrorMessage(l10n.t('Failed to send context: {0}', 'agent prompt failed'));
        }
        return success;
    }

    // Multiple agents: QuickPick with Idle prioritized
    const quickPickItems = sorted.map(agent => {
        let icon = '$(hubot)';
        let statusTag = '';
        if (agent.statusType === 'idle') {
            icon = '$(circle-filled)';
            statusTag = ` ${l10n.t('(Idle)')}`;
        } else if (agent.statusType === 'waiting') {
            icon = '$(alert)';
            statusTag = ` ${l10n.t('(Input Needed)')}`;
        } else if (agent.statusType === 'working') {
            icon = '$(sync~spin)';
            statusTag = ` ${l10n.t('(Working)')}`;
        }

        const wsInfo = agent.workspaceLabel ? ` [${agent.workspaceLabel}]` : '';
        return {
            label: `${icon} ${agent.name}${statusTag}${wsInfo}`,
            description: agent.status,
            detail: agent.cwd ? `Path: ${agent.cwd}` : undefined,
            agent
        };
    });

    const selected = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: l10n.t('Select Herdr Agent to dispatch task to:'),
        title: taskTitle
    });

    if (!selected) {
        return false;
    }

    const success = await sendPromptToAgent(selected.agent.id, prompt, options);
    if (success) {
        vscode.window.showInformationMessage(l10n.t("Dispatched task to '{0}'", selected.agent.name));
    } else {
        vscode.window.showErrorMessage(l10n.t('Failed to send context: {0}', 'agent prompt failed'));
    }
    return success;
}

/**
 * Herdr CodeAction Provider for Lightbulb Quick-Fix (Cmd+. / Ctrl+.)
 */
export class HerdrQuickFixProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token?: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        const isEnabled = config.get<boolean>('quickFix.enable', true);
        if (!isEnabled || !context.diagnostics || context.diagnostics.length === 0) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];
        const diags = context.diagnostics;

        // Action 1: Delegate primary diagnostic
        const primaryDiag = diags[0];
        const primaryAction = new vscode.CodeAction(
            `🛠️ ${l10n.t('Delegate Fix to Herdr Agent')}`,
            vscode.CodeActionKind.QuickFix
        );
        primaryAction.isPreferred = true;
        primaryAction.diagnostics = [primaryDiag];
        primaryAction.command = {
            command: 'herdr-collie.fixDiagnosticWithAgent',
            title: l10n.t('Delegate Fix to Herdr Agent'),
            arguments: [document.uri, primaryDiag]
        };
        actions.push(primaryAction);

        // Action 2: Delegate all diagnostics if multiple exist
        if (diags.length > 1) {
            const allAction = new vscode.CodeAction(
                `🛠️ ${l10n.t('Delegate All Issues on Line to Herdr Agent')}`,
                vscode.CodeActionKind.QuickFix
            );
            allAction.diagnostics = [...diags];
            allAction.command = {
                command: 'herdr-collie.fixDiagnosticWithAgent',
                title: l10n.t('Delegate All Issues on Line to Herdr Agent'),
                arguments: [document.uri, diags]
            };
            actions.push(allAction);
        }

        return actions;
    }
}

/**
 * Herdr CodeLens Provider for inline Test and TODO links
 */
export class HerdrCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        _token?: vscode.CancellationToken
    ): vscode.CodeLens[] {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        const isEnabled = config.get<boolean>('codeLens.enable', true);
        if (!isEnabled) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const maxScanLines = Math.min(document.lineCount, 3000);

        for (let i = 0; i < maxScanLines; i++) {
            const line = document.lineAt(i);
            const lineText = line.text;
            const prevLineText = i > 0 ? document.lineAt(i - 1).text : undefined;

            // 1. Test Detection
            const testResult = detectTestAtLine(lineText, prevLineText);
            if (testResult) {
                const range = new vscode.Range(i, 0, i, 0);

                codeLenses.push(new vscode.CodeLens(range, {
                    title: l10n.t('▶ Fix Test with Herdr Agent'),
                    command: 'herdr-collie.fixTestWithAgent',
                    arguments: [document.uri, testResult.testName, i + 1, 'fix']
                }));

                codeLenses.push(new vscode.CodeLens(range, {
                    title: l10n.t('🧪 Generate Edge Cases with Herdr Agent'),
                    command: 'herdr-collie.fixTestWithAgent',
                    arguments: [document.uri, testResult.testName, i + 1, 'edge-cases']
                }));
            }

            // 2. TODO / FIXME Detection
            const todoResult = detectTodoAtLine(lineText);
            if (todoResult) {
                const range = new vscode.Range(i, 0, i, 0);
                codeLenses.push(new vscode.CodeLens(range, {
                    title: l10n.t('✔ Complete {0} with Herdr Agent', todoResult.type),
                    command: 'herdr-collie.completeTodoWithAgent',
                    arguments: [document.uri, todoResult.type, todoResult.text, i + 1]
                }));
            }
        }

        return codeLenses;
    }
}

/**
 * Handles keyboard context dispatch (`Ctrl+Alt+H Enter`)
 */
export async function handleContextTaskDispatch(
    editor: vscode.TextEditor,
    options?: { socketClient?: HerdrSocketClient; sessionName?: string }
): Promise<void> {
    const doc = editor.document;
    const fileRelPath = (typeof vscode.workspace.asRelativePath === 'function' ? vscode.workspace.asRelativePath(doc.uri) : '') || doc.uri.fsPath || doc.uri.path || 'file';
    const lineNum = editor.selection.active.line + 1;
    const activeLineText = doc.lineAt(editor.selection.active.line).text;
    const prevLineText = editor.selection.active.line > 0 ? doc.lineAt(editor.selection.active.line - 1).text : undefined;

    // 1. Check diagnostics at cursor
    const diags = vscode.languages.getDiagnostics(doc.uri).filter(d => {
        return d.range.start.line <= editor.selection.active.line && d.range.end.line >= editor.selection.active.line;
    });

    if (diags.length > 0) {
        const primaryDiag = diags[0];
        const snippet = extractSnippet(doc.getText(), Math.max(1, lineNum - 5), Math.min(doc.lineCount, lineNum + 5));
        const prompt = formatDiagnosticPrompt(fileRelPath, lineNum, primaryDiag, snippet);
        await promptAndDispatchTask(prompt, `Fix Diagnostic in ${path.basename(fileRelPath)}`, options);
        return;
    }

    // 2. Check TODO / FIXME at current line
    const todoMatch = detectTodoAtLine(activeLineText);
    if (todoMatch) {
        const snippet = extractSnippet(doc.getText(), Math.max(1, lineNum - 6), Math.min(doc.lineCount, lineNum + 8));
        const prompt = formatTodoPrompt(fileRelPath, todoMatch.type, todoMatch.text, lineNum, snippet);
        await promptAndDispatchTask(prompt, `Complete ${todoMatch.type} in ${path.basename(fileRelPath)}`, options);
        return;
    }

    // 3. Check test definition at current line
    const testMatch = detectTestAtLine(activeLineText, prevLineText);
    if (testMatch) {
        const snippet = extractSnippet(doc.getText(), Math.max(1, lineNum - 2), Math.min(doc.lineCount, lineNum + 20));
        const prompt = formatTestPrompt(fileRelPath, testMatch.testName, lineNum, snippet, 'fix');
        await promptAndDispatchTask(prompt, `Fix Test "${testMatch.testName}"`, options);
        return;
    }

    // 4. Check selection or prompt for context action
    let snippet: string;
    let targetLinesDesc: string;
    if (!editor.selection.isEmpty) {
        snippet = doc.getText(editor.selection);
        const s = editor.selection.start.line + 1;
        const e = editor.selection.end.line + 1;
        targetLinesDesc = s === e ? `Line ${s}` : `Lines ${s}-${e}`;
    } else {
        snippet = extractSnippet(doc.getText(), Math.max(1, lineNum - 8), Math.min(doc.lineCount, lineNum + 8));
        targetLinesDesc = `Line ${lineNum}`;
    }

    const actionChoices = [
        { label: `🛠️ ${l10n.t('Refactor / Improve Code')}`, action: 'refactor' },
        { label: `🧪 ${l10n.t('Generate Tests for Code')}`, action: 'tests' },
        { label: `💡 ${l10n.t('Explain / Document Code')}`, action: 'explain' },
        { label: `✏️ ${l10n.t('Custom Instruction...')}`, action: 'custom' }
    ];

    const chosen = await vscode.window.showQuickPick(actionChoices, {
        placeHolder: l10n.t('Select Action for Current Context'),
        title: `${path.basename(fileRelPath)} (${targetLinesDesc})`
    });

    if (!chosen) return;

    let instruction = '';
    if (chosen.action === 'refactor') {
        instruction = 'Refactor this code to improve clarity, performance, and robustness while preserving behavior.';
    } else if (chosen.action === 'tests') {
        instruction = 'Generate comprehensive unit tests and edge cases for this code.';
    } else if (chosen.action === 'explain') {
        instruction = 'Explain how this code works and document any non-obvious design choices or potential pitfalls.';
    } else if (chosen.action === 'custom') {
        const customPrompt = await vscode.window.showInputBox({
            title: l10n.t('Custom Instruction...'),
            prompt: l10n.t('Enter custom instruction for the agent'),
            placeHolder: l10n.t('e.g. Optimize time complexity to O(N), add null checks')
        });
        if (!customPrompt || !customPrompt.trim()) return;
        instruction = customPrompt.trim();
    }

    const prompt = formatContextTaskPrompt(fileRelPath, lineNum, instruction, snippet);
    await promptAndDispatchTask(prompt, `Dispatch Task: ${path.basename(fileRelPath)}`, options);
}
