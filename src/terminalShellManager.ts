/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { formatTerminalOutput } from './formatters';

export type TerminalFailureActionMode = 'prompt' | 'statusbar' | 'off';

export interface TerminalShellExecutionLike {
    commandLine: {
        value: string;
        confidence?: number;
        isTrusted?: boolean;
    };
    cwd?: { fsPath: string };
    read(): AsyncIterable<string>;
}

export interface TerminalShellExecutionStartEventLike {
    terminal: vscode.Terminal;
    shellIntegration?: any;
    execution: TerminalShellExecutionLike;
}

export interface TerminalShellExecutionEndEventLike {
    terminal: vscode.Terminal;
    shellIntegration?: any;
    execution: TerminalShellExecutionLike;
    exitCode: number | undefined;
}

export interface TerminalExecutionRecord {
    id: string;
    terminalName: string;
    commandLine: string;
    cwd?: string;
    exitCode?: number;
    output: string;
    startedAt: number;
    endedAt: number;
    failed: boolean;
}

export interface TerminalPromptDispatchOptions {
    stageOnly?: boolean;
    preferredCwd?: string;
}

export type TerminalPromptDispatcher = (
    prompt: string,
    successMsg: string,
    quickPickTitle: string,
    options?: TerminalPromptDispatchOptions
) => Promise<boolean>;

const MAX_CAPTURED_STREAM_CHARS = 80000;
const DEFAULT_PROMPT_OUTPUT_CHARS = 30000;
const MAX_EXECUTION_HISTORY = 20;
const STREAM_DRAIN_TIMEOUT_MS = 500;
const FAILURE_NOTIFY_COOLDOWN_MS = 8000;

/**
 * Strips ANSI CSI, OSC (including VS Code 633 shell integration markers), and control characters
 * from raw terminal execution streams while preserving readable line breaks and indentation.
 */
export function stripTerminalControlSequences(raw: string): string {
    if (!raw) return '';

    const normalized = raw
        // OSC sequences: ESC ] ... BEL or ESC \
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // DCS / SOS / PM / APC sequences
        .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
        // CSI sequences: ESC [ ... final byte
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        // Remaining 2-byte ESC sequences (e.g. charset switches)
        .replace(/\x1b[@-Z\\-_]|\x1b[()][A-Za-z0-9]/g, '')
        // Normalize CRLF -> LF
        .replace(/\r\n/g, '\n')
        // Collapse standalone CR progress updates onto newlines cleanly, then remove remaining C0 controls (except \t and \n)
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    return normalized.trim();
}

/**
 * Keeps the trailing lines/characters of long terminal logs where failure stack traces usually live.
 */
export function truncateOutputTail(text: string, maxChars = DEFAULT_PROMPT_OUTPUT_CHARS): string {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    const prefix = '... (earlier output omitted)\n';
    const budget = Math.max(200, maxChars - prefix.length);
    return prefix + text.slice(-budget);
}

/**
 * Identifies terminals managed directly by Herdr TUI so interactive sessions do not trigger false failure prompts.
 */
export function isHerdrManagedTerminal(terminal: { name?: string } | undefined): boolean {
    const name = (terminal?.name || '').trim();
    if (!name) return false;
    return name === 'Herdr' || name.startsWith('Herdr:') || name.startsWith('Herdr (');
}

/**
 * Determines whether a shell execution exit code should be ignored for failure notifications.
 * Exit code 0 is success, undefined means unknown/interactive, and 130 is user Ctrl+C interrupt.
 */
export function shouldIgnoreExitCode(exitCode: number | undefined, commandLine?: string): boolean {
    if (exitCode === undefined || exitCode === 0 || exitCode === 130) {
        return true;
    }
    if (!commandLine || !commandLine.trim()) {
        return true;
    }
    return false;
}

/**
 * Formats a captured Shell Integration command record into a structured Herdr agent prompt.
 */
export function formatFailedCommandPrompt(record: TerminalExecutionRecord, maxOutputChars = DEFAULT_PROMPT_OUTPUT_CHARS): string {
    const cleaned = truncateOutputTail(record.output || '', maxOutputChars);
    const body = cleaned || `(No terminal output captured for exit code ${record.exitCode ?? 'unknown'})`;
    const base = formatTerminalOutput(
        record.terminalName,
        body,
        record.commandLine || undefined,
        record.exitCode
    );
    if (!base) return '';
    return record.cwd ? `**Working Directory:** \`${record.cwd}\`\n${base}` : base;
}

interface CapturedStreamState {
    buffer: string;
    donePromise: Promise<void>;
}

/**
 * Monitors VS Code Terminal Shell Integration executions (VS Code 1.93+) when available,
 * capturing structured command outputs, surfacing non-zero exit QuickFix triggers, and
 * dispatching failed commands cleanly to Herdr agents.
 */
export class TerminalShellMonitor implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly activeStreams = new WeakMap<object, CapturedStreamState>();
    private readonly latestByTerminal = new WeakMap<object, TerminalExecutionRecord>();
    private readonly history: TerminalExecutionRecord[] = [];
    private readonly failedStatusBarItem: vscode.StatusBarItem;

    private currentFailedRecord: TerminalExecutionRecord | undefined;
    private executionCounter = 0;
    private lastNotifiedSignature = '';
    private lastNotifiedAt = 0;

    constructor(
        private readonly dispatchPrompt: TerminalPromptDispatcher,
        private readonly onFallbackFix?: () => Promise<void>
    ) {
        this.failedStatusBarItem = vscode.window.createStatusBarItem(
            'herdr-collie.terminalFailure',
            vscode.StatusBarAlignment.Right,
            98
        );
        this.failedStatusBarItem.command = 'herdr-collie.fixLastFailedCommand';
        this.failedStatusBarItem.hide();
        this.disposables.push(this.failedStatusBarItem);

        const winAny = vscode.window as any;
        if (typeof winAny.onDidStartTerminalShellExecution === 'function') {
            this.disposables.push(
                winAny.onDidStartTerminalShellExecution((event: TerminalShellExecutionStartEventLike) => {
                    this.handleExecutionStart(event);
                })
            );
        }
        if (typeof winAny.onDidEndTerminalShellExecution === 'function') {
            this.disposables.push(
                winAny.onDidEndTerminalShellExecution((event: TerminalShellExecutionEndEventLike) => {
                    void this.handleExecutionEnd(event);
                })
            );
        }
        if (typeof winAny.onDidCloseTerminal === 'function') {
            this.disposables.push(
                winAny.onDidCloseTerminal((terminal: vscode.Terminal) => {
                    if (this.currentFailedRecord && this.currentFailedRecord.terminalName === terminal.name) {
                        this.latestByTerminal.delete(terminal);
                    }
                })
            );
        }
    }

    public get isShellIntegrationSupported(): boolean {
        const winAny = vscode.window as any;
        return typeof winAny.onDidEndTerminalShellExecution === 'function';
    }

    public handleExecutionStart(event: TerminalShellExecutionStartEventLike): void {
        if (!event?.execution || typeof event.execution.read !== 'function') return;
        const streamState: CapturedStreamState = {
            buffer: '',
            donePromise: Promise.resolve()
        };

        streamState.donePromise = (async () => {
            try {
                for await (const chunk of event.execution.read()) {
                    if (typeof chunk !== 'string') continue;
                    streamState.buffer += chunk;
                    if (streamState.buffer.length > MAX_CAPTURED_STREAM_CHARS * 1.5) {
                        streamState.buffer = streamState.buffer.slice(-MAX_CAPTURED_STREAM_CHARS);
                    }
                }
            } catch {
                // Terminal closed or stream aborted
            }
        })();

        this.activeStreams.set(event.execution, streamState);
    }

    public async handleExecutionEnd(event: TerminalShellExecutionEndEventLike): Promise<TerminalExecutionRecord | undefined> {
        if (!event?.terminal || !event?.execution) return undefined;

        const commandLine = (event.execution.commandLine?.value || '').trim();
        let rawOutput = '';
        const streamState = this.activeStreams.get(event.execution);
        if (streamState) {
            await Promise.race([
                streamState.donePromise,
                new Promise<void>(resolve => setTimeout(resolve, STREAM_DRAIN_TIMEOUT_MS))
            ]);
            rawOutput = streamState.buffer;
            this.activeStreams.delete(event.execution);
        } else if (typeof event.execution.read === 'function') {
            // Fallback in case execution end fired without start subscription
            try {
                const collectTask = (async () => {
                    for await (const chunk of event.execution.read()) {
                        rawOutput += chunk;
                        if (rawOutput.length > MAX_CAPTURED_STREAM_CHARS * 1.5) {
                            rawOutput = rawOutput.slice(-MAX_CAPTURED_STREAM_CHARS);
                        }
                    }
                })();
                await Promise.race([
                    collectTask,
                    new Promise<void>(resolve => setTimeout(resolve, 150))
                ]);
            } catch {
                // Ignore read failure
            }
        }

        const cleanedOutput = truncateOutputTail(
            stripTerminalControlSequences(rawOutput),
            MAX_CAPTURED_STREAM_CHARS
        );
        const now = Date.now();
        const isManagedHerdr = isHerdrManagedTerminal(event.terminal);
        const failed = !isManagedHerdr && !shouldIgnoreExitCode(event.exitCode, commandLine);

        const record: TerminalExecutionRecord = {
            id: `exec-${++this.executionCounter}`,
            terminalName: event.terminal.name || 'Terminal',
            commandLine,
            cwd: event.execution.cwd?.fsPath,
            exitCode: event.exitCode,
            output: cleanedOutput,
            startedAt: now,
            endedAt: now,
            failed
        };

        this.latestByTerminal.set(event.terminal, record);
        if (commandLine || cleanedOutput) {
            this.history.unshift(record);
            if (this.history.length > MAX_EXECUTION_HISTORY) {
                this.history.length = MAX_EXECUTION_HISTORY;
            }
        }

        if (event.exitCode === 0 && !isManagedHerdr) {
            if (this.currentFailedRecord && this.currentFailedRecord.terminalName === record.terminalName) {
                this.clearFailedIndicator();
            }
            return record;
        }

        if (failed) {
            await this.handleFailedExecution(record);
        }

        return record;
    }

    private getFailureActionMode(): TerminalFailureActionMode {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        const mode = config.get<TerminalFailureActionMode>('terminal.failureAction', 'prompt');
        return mode || 'prompt';
    }

    private async handleFailedExecution(record: TerminalExecutionRecord): Promise<void> {
        const mode = this.getFailureActionMode();
        if (mode === 'off') return;

        this.currentFailedRecord = record;
        const shortCmd = record.commandLine.length > 28
            ? `${record.commandLine.slice(0, 25)}...`
            : record.commandLine;
        this.failedStatusBarItem.text = `$(warning) Fix: ${shortCmd} (exit ${record.exitCode})`;
        this.failedStatusBarItem.tooltip = l10n.t(
            "Command '{0}' failed with exit code {1}. Click to fix with a Herdr agent.",
            record.commandLine,
            String(record.exitCode ?? '?')
        );
        this.failedStatusBarItem.show();

        if (mode !== 'prompt') return;

        const signature = `${record.terminalName}:${record.commandLine}:${record.exitCode}`;
        const now = Date.now();
        if (signature === this.lastNotifiedSignature && (now - this.lastNotifiedAt) < FAILURE_NOTIFY_COOLDOWN_MS) {
            return;
        }
        this.lastNotifiedSignature = signature;
        this.lastNotifiedAt = now;

        const fixBtn = l10n.t('Fix with Herdr Agent');
        const stageBtn = l10n.t('Stage in Agent');
        const dismissBtn = l10n.t('Dismiss');

        const choice = await vscode.window.showWarningMessage(
            l10n.t("Command '{0}' failed (exit code {1}). Delegate fix to a Herdr agent?", shortCmd, String(record.exitCode ?? '?')),
            fixBtn,
            stageBtn,
            dismissBtn
        );

        if (choice === fixBtn) {
            await this.sendExecutionRecord(record, false);
        } else if (choice === stageBtn) {
            await this.sendExecutionRecord(record, true);
        } else if (choice === dismissBtn) {
            this.clearFailedIndicator();
        }
    }

    public getLatestExecution(terminal?: vscode.Terminal): TerminalExecutionRecord | undefined {
        if (terminal) {
            return this.latestByTerminal.get(terminal);
        }
        return this.history[0];
    }

    public getRecentExecutions(failedOnly = false): TerminalExecutionRecord[] {
        return failedOnly ? this.history.filter(r => r.failed) : [...this.history];
    }

    public getCurrentFailedRecord(): TerminalExecutionRecord | undefined {
        return this.currentFailedRecord;
    }

    public clearFailedIndicator(): void {
        this.currentFailedRecord = undefined;
        this.failedStatusBarItem.hide();
    }

    public async sendExecutionRecord(record: TerminalExecutionRecord, stageOnly = false): Promise<boolean> {
        const prompt = formatFailedCommandPrompt(record);
        if (!prompt) return false;

        const shortCmd = record.commandLine || record.terminalName;
        const successMsg = stageOnly
            ? l10n.t("Staged command '{0}' failure in agent input", shortCmd)
            : l10n.t("Sent command '{0}' (exit {1}) to Herdr agent", shortCmd, String(record.exitCode ?? 0));
        const quickPickTitle = record.failed
            ? l10n.t('Fix Failed Terminal Command ({0})', shortCmd)
            : l10n.t('Send Terminal Output to Herdr');

        const sent = await this.dispatchPrompt(prompt, successMsg, quickPickTitle, {
            stageOnly,
            preferredCwd: record.cwd
        });

        if (sent && record.failed && this.currentFailedRecord?.id === record.id) {
            this.clearFailedIndicator();
        }
        return sent;
    }

    public async fixFailedExecutionWizard(): Promise<void> {
        const failedHistory = this.getRecentExecutions(true);
        const targetList = failedHistory.length > 0 ? failedHistory : this.getRecentExecutions(false);

        if (targetList.length === 0) {
            if (this.onFallbackFix) {
                await this.onFallbackFix();
            } else {
                vscode.window.showInformationMessage(l10n.t('No recent terminal command executions captured yet.'));
            }
            return;
        }

        if (failedHistory.length === 1) {
            await this.sendExecutionRecord(failedHistory[0], false);
            return;
        }

        const picked = await vscode.window.showQuickPick(
            targetList.map(rec => ({
                label: `${rec.failed ? '$(error)' : '$(terminal)'} ${rec.commandLine || rec.terminalName}`,
                description: `exit ${rec.exitCode ?? '?'} | ${rec.terminalName}`,
                detail: rec.cwd,
                record: rec
            })),
            {
                title: l10n.t('Select Terminal Command to Fix / Send'),
                placeHolder: l10n.t('Choose a failed or recent terminal command execution')
            }
        );

        if (!picked) return;
        await this.sendExecutionRecord(picked.record, false);
    }

    public dispose(): void {
        while (this.disposables.length > 0) {
            try {
                this.disposables.pop()?.dispose();
            } catch {}
        }
    }
}
