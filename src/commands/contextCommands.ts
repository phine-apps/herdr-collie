/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { execHerdr, getErrorMessage, runGitCmd } from '../executors';
import {
    formatSelectionContext,
    formatFileDiagnostics,
    formatWorkspaceProblems,
    formatGitDiff,
    formatBranchContext,
    formatHoverInfo,
    formatTerminalOutput
} from '../formatters';
import {
    promptAndDispatchTask,
    handleContextTaskDispatch,
    buildDiagnosticFixPrompt,
    formatTestPrompt,
    formatTodoPrompt
} from '../microTaskManager';
import { extractSnippet } from '../reviewManager';
import { ensureWorkspaceTrustedForAction } from '../workspaceTrust';
import { resolveGitContextForUri, captureTerminalOutputWithClipboard } from '../gitContext';
import { CommandContext } from './types';

export function registerContextCommands(context: vscode.ExtensionContext, ctx: CommandContext): void {
    const sendContextDisposable = vscode.commands.registerCommand('herdr-collie.sendContext', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.selection;
        const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
        if (!text.trim()) return;
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const richText = formatSelectionContext(fileName, startLine, endLine, editor.document.languageId, text);
        await ctx.sendToHerdr(richText, l10n.t('Context sent successfully'), l10n.t('Send Selection to Herdr'));
    });

    const sendDiagnosticsDisposable = vscode.commands.registerCommand('herdr-collie.sendDiagnostics', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        if (diagnostics.length === 0) {
            vscode.window.showInformationMessage(l10n.t('No errors or warnings found.'));
            return;
        }
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const richText = formatFileDiagnostics(
            fileName,
            diagnostics.map(d => ({ line: d.range.start.line + 1, message: d.message }))
        );
        await ctx.sendToHerdr(richText, l10n.t('Diagnostics sent successfully'), l10n.t('Send Diagnostics to Herdr'));
    });

    const sendStagedChangesDisposable = vscode.commands.registerCommand('herdr-collie.sendStagedChanges', async (...args) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const resourceUri = args.length > 0 && args[0] && args[0].resourceUri
            ? (args[0].resourceUri as vscode.Uri)
            : undefined;
        const gitCtx = await resolveGitContextForUri(resourceUri, vscode.window.activeTextEditor?.document.uri);
        if (!gitCtx) return;
        const { cwd, targetFile } = gitCtx;

        try {
            const gitArgs = targetFile ? ['diff', '--cached', '--', targetFile] : ['diff', '--cached'];
            const stdout = await runGitCmd(gitArgs, cwd);
            if (!stdout.trim()) {
                vscode.window.showInformationMessage(l10n.t('No staged changes found{0}.', targetFile ? l10n.t(' for this file') : ''));
                return;
            }
            const richText = formatGitDiff(stdout, targetFile, true);
            await ctx.sendToHerdr(richText, l10n.t('Staged Changes sent successfully'), l10n.t('Send Staged Changes to Herdr'));
        } catch (e: unknown) {
            vscode.window.showErrorMessage(l10n.t('Failed to get staged changes: {0}', getErrorMessage(e)));
        }
    });

    const sendWorkingTreeChangesDisposable = vscode.commands.registerCommand('herdr-collie.sendWorkingTreeChanges', async (...args) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const resourceUri = args.length > 0 && args[0] && args[0].resourceUri
            ? (args[0].resourceUri as vscode.Uri)
            : undefined;
        const gitCtx = await resolveGitContextForUri(resourceUri, vscode.window.activeTextEditor?.document.uri);
        if (!gitCtx) return;
        const { cwd, targetFile } = gitCtx;

        try {
            const gitArgs = targetFile ? ['diff', '--', targetFile] : ['diff'];
            const stdout = await runGitCmd(gitArgs, cwd);
            if (!stdout.trim()) {
                vscode.window.showInformationMessage(l10n.t('No working tree changes found{0}.', targetFile ? l10n.t(' for this file') : ''));
                return;
            }
            const richText = formatGitDiff(stdout, targetFile, false);
            await ctx.sendToHerdr(richText, l10n.t('Working Tree Changes sent successfully'), l10n.t('Send Working Tree Changes to Herdr'));
        } catch (e: unknown) {
            vscode.window.showErrorMessage(l10n.t('Failed to get working tree changes: {0}', getErrorMessage(e)));
        }
    });

    const sendBranchContextDisposable = vscode.commands.registerCommand('herdr-collie.sendBranchContext', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const gitCtx = await resolveGitContextForUri(undefined, vscode.window.activeTextEditor?.document.uri);
        if (!gitCtx) return;
        const cwd = gitCtx.cwd;

        try {
            const branchOut = await runGitCmd(['branch', '--show-current'], cwd);
            const currentBranch = branchOut.trim() || 'HEAD detached';

            let logArgs = ['log', '-n', '15', '--oneline'];
            try {
                const hasMain = (await runGitCmd(['rev-parse', '--verify', 'main'], cwd).catch(() => '')).trim() !== '';
                const baseBranch = hasMain ? 'main' : 'master';
                logArgs = ['log', `${baseBranch}..HEAD`, '--oneline'];
            } catch {
                // Ignore fallback to recent 15 commits
            }

            let logOut = await runGitCmd(logArgs, cwd);
            if (!logOut.trim()) {
                logOut = await runGitCmd(['log', '-n', '15', '--oneline'], cwd);
            }

            const richText = formatBranchContext(currentBranch, logOut);
            await ctx.sendToHerdr(richText, l10n.t('Branch Context sent successfully'), l10n.t('Send Branch Context to Herdr'));
        } catch (e: unknown) {
            vscode.window.showErrorMessage(l10n.t('Failed to get branch context: {0}', getErrorMessage(e)));
        }
    });

    const sendWorkspaceProblemsDisposable = vscode.commands.registerCommand('herdr-collie.sendWorkspaceProblems', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const diagnostics = vscode.languages.getDiagnostics();
        const problemsByFile: { [file: string]: { line: number; severity: 'Error' | 'Warning'; message: string }[] } = {};

        for (const [uri, fileDiagnostics] of diagnostics) {
            if (fileDiagnostics.length === 0) continue;

            const issues = fileDiagnostics.filter(d =>
                d.severity === vscode.DiagnosticSeverity.Error ||
                d.severity === vscode.DiagnosticSeverity.Warning
            );

            if (issues.length === 0) continue;

            const relativePath = vscode.workspace.asRelativePath(uri);
            problemsByFile[relativePath] = issues.map(d => ({
                line: d.range.start.line + 1,
                severity: (d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning') as 'Error' | 'Warning',
                message: d.message
            }));
        }

        const richText = formatWorkspaceProblems(problemsByFile);
        if (!richText) {
            vscode.window.showInformationMessage(l10n.t('No workspace problems (Errors/Warnings) found.'));
            return;
        }

        await ctx.sendToHerdr(richText, l10n.t('Workspace Problems sent successfully'), l10n.t('Send Workspace Problems to Herdr'));
    });

    const sendHoverInfoDisposable = vscode.commands.registerCommand('herdr-collie.sendHoverInfo', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(l10n.t('Please place your cursor on a symbol in the editor.'));
            return;
        }

        const position = editor.selection.active;
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, position);

        if (!hovers || hovers.length === 0) {
            vscode.window.showInformationMessage(l10n.t('No hover information available for this symbol.'));
            return;
        }

        const hoverContents: string[] = [];
        for (const hover of hovers) {
            for (const content of hover.contents) {
                if (typeof content === 'string') {
                    hoverContents.push(content);
                } else {
                    hoverContents.push(content.value);
                }
            }
        }

        const wordRange = editor.document.getWordRangeAtPosition(position);
        const symbolName = wordRange ? editor.document.getText(wordRange) : 'the symbol';

        const richText = formatHoverInfo(symbolName, hoverContents);
        await ctx.sendToHerdr(richText, l10n.t('Symbol Hover Info sent successfully'), l10n.t('Send Symbol Info to Herdr'));
    });

    const sendTerminalOutputDisposable = vscode.commands.registerCommand('herdr-collie.sendTerminalOutput', async (terminalArg?: vscode.Terminal) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const terminal = terminalArg || vscode.window.activeTerminal;
        if (!terminal) {
            const latestAny = ctx.terminalShellMonitor.getLatestExecution();
            if (latestAny) {
                await ctx.terminalShellMonitor.sendExecutionRecord(latestAny, false);
                return;
            }
            vscode.window.showInformationMessage(l10n.t('No active terminal found.'));
            return;
        }

        const selectedText = await captureTerminalOutputWithClipboard(
            vscode.env.clipboard,
            (cmd) => vscode.commands.executeCommand(cmd),
            { selectAllFallback: false }
        );
        if (selectedText && selectedText.trim()) {
            const lines = selectedText.split('\n');
            const recentText = lines.length > 200 ? lines.slice(-200).join('\n') : selectedText;
            const richText = formatTerminalOutput(terminal.name, recentText);
            await ctx.sendToHerdr(richText, l10n.t('Terminal Output sent successfully'), l10n.t('Send Terminal Output to Herdr'));
            return;
        }

        const latestExecution = ctx.terminalShellMonitor.getLatestExecution(terminal);
        if (latestExecution && (latestExecution.output.trim() || latestExecution.commandLine)) {
            await ctx.terminalShellMonitor.sendExecutionRecord(latestExecution, false);
            return;
        }

        const outputText = await captureTerminalOutputWithClipboard(
            vscode.env.clipboard,
            (cmd) => vscode.commands.executeCommand(cmd)
        );

        if (!outputText || !outputText.trim()) {
            vscode.window.showInformationMessage(l10n.t('No terminal output or selection found.'));
            return;
        }

        const lines = outputText.split('\n');
        const recentText = lines.length > 200 ? lines.slice(-200).join('\n') : outputText;

        const richText = formatTerminalOutput(terminal.name, recentText);
        await ctx.sendToHerdr(richText, l10n.t('Terminal Output sent successfully'), l10n.t('Send Terminal Output to Herdr'));
    });

    const fixLastFailedCommandDisposable = vscode.commands.registerCommand('herdr-collie.fixLastFailedCommand', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        await ctx.terminalShellMonitor.fixFailedExecutionWizard();
    });

    const fixDiagnosticDisposable = vscode.commands.registerCommand('herdr-collie.fixDiagnosticWithAgent', async (uriArg?: vscode.Uri, diagArg?: vscode.Diagnostic | vscode.Diagnostic[]) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        const uri = uriArg || editor?.document.uri;
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        const fileRelPath = vscode.workspace.asRelativePath(uri);
        let diag = diagArg;
        if (!diag) {
            const diags = vscode.languages.getDiagnostics(uri);
            if (diags.length > 0) diag = diags[0];
        }
        if (!diag || (Array.isArray(diag) && diag.length === 0)) {
            vscode.window.showInformationMessage(l10n.t('No errors or warnings found.'));
            return;
        }
        const prompt = buildDiagnosticFixPrompt(fileRelPath, doc.getText(), doc.lineCount, diag);
        await promptAndDispatchTask(prompt, l10n.t('Fix Issue in {0}', path.basename(fileRelPath)), {
            socketClient: ctx.getSocketClient(),
            sessionName: ctx.getActiveSidebarSession()
        });
    });

    const fixTestDisposable = vscode.commands.registerCommand('herdr-collie.fixTestWithAgent', async (uriArg?: vscode.Uri, testNameArg?: string, lineArg?: number, modeArg?: 'fix' | 'edge-cases') => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        const uri = uriArg || editor?.document.uri;
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        const fileRelPath = vscode.workspace.asRelativePath(uri);
        const line = lineArg ?? ((editor?.selection.active.line ?? 0) + 1);
        const testName = testNameArg || 'test';
        const mode = modeArg || 'fix';
        const snippet = extractSnippet(doc.getText(), Math.max(1, line - 2), Math.min(doc.lineCount, line + 25));
        const prompt = formatTestPrompt(fileRelPath, testName, line, snippet, mode);
        const taskTitle = mode === 'fix'
            ? l10n.t('Fix Test "{0}"', testName)
            : l10n.t('Generate Edge Cases for "{0}"', testName);
        await promptAndDispatchTask(prompt, taskTitle, {
            socketClient: ctx.getSocketClient(),
            sessionName: ctx.getActiveSidebarSession()
        });
    });

    const completeTodoDisposable = vscode.commands.registerCommand('herdr-collie.completeTodoWithAgent', async (uriArg?: vscode.Uri, todoTypeArg?: string, todoTextArg?: string, lineArg?: number) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        const uri = uriArg || editor?.document.uri;
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        const fileRelPath = vscode.workspace.asRelativePath(uri);
        const line = lineArg ?? ((editor?.selection.active.line ?? 0) + 1);
        const todoType = todoTypeArg || 'TODO';
        const todoText = todoTextArg || '';
        const snippet = extractSnippet(doc.getText(), Math.max(1, line - 6), Math.min(doc.lineCount, line + 10));
        const prompt = formatTodoPrompt(fileRelPath, todoType, todoText, line, snippet);
        await promptAndDispatchTask(prompt, l10n.t('Complete {0} in {1}', todoType, path.basename(fileRelPath)), {
            socketClient: ctx.getSocketClient(),
            sessionName: ctx.getActiveSidebarSession()
        });
    });

    const dispatchContextTaskDisposable = vscode.commands.registerCommand('herdr-collie.dispatchContextTask', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(l10n.t('Please open a file in the editor first.'));
            return;
        }
        await handleContextTaskDispatch(editor, {
            socketClient: ctx.getSocketClient(),
            sessionName: ctx.getActiveSidebarSession()
        });
    });

    context.subscriptions.push(
        sendContextDisposable,
        sendDiagnosticsDisposable,
        sendStagedChangesDisposable,
        sendWorkingTreeChangesDisposable,
        sendBranchContextDisposable,
        sendWorkspaceProblemsDisposable,
        sendHoverInfoDisposable,
        sendTerminalOutputDisposable,
        fixLastFailedCommandDisposable,
        fixDiagnosticDisposable,
        fixTestDisposable,
        completeTodoDisposable,
        dispatchContextTaskDisposable
    );
}
