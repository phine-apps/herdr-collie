/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import cp = require('child_process');
import { resetMockState, mockVscode } from '../helpers/mockVscode';
import {
    isHerdrRunningInTerminal,
    captureTerminalOutputWithClipboard,
    computeGitRelativePath,
    resolveGitContextForUri
} from '../../extension';

describe('Terminal Recovery & Health Unit Tests', () => {
    let originalExecFile: any;
    let mockStdout = '';
    let mockError: any = null;

    beforeEach(() => {
        originalExecFile = cp.execFile;
        mockStdout = '';
        mockError = null;
        (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
            let cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
            if (cb) {
                cb(mockError, mockStdout, '');
            }
            return {} as any;
        };
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
    });

    describe('isHerdrRunningInTerminal', () => {
        it('returns false when terminal has exited (exitStatus is defined)', async () => {
            const mockTerminal: any = {
                name: 'Herdr (vscode)',
                exitStatus: { code: 0 },
                processId: Promise.resolve(100)
            };
            const result = await isHerdrRunningInTerminal(mockTerminal);
            expect(result).to.be.false;
        });

        it('returns false when terminal processId is undefined or 0', async () => {
            const mockTerminal: any = {
                name: 'Herdr (vscode)',
                exitStatus: undefined,
                processId: Promise.resolve(undefined)
            };
            const result = await isHerdrRunningInTerminal(mockTerminal);
            expect(result).to.be.false;
        });

        it('returns false when terminal processId rejects', async () => {
            const mockTerminal: any = {
                name: 'Herdr (vscode)',
                exitStatus: undefined,
                processId: Promise.reject(new Error('Process unavailable'))
            };
            const result = await isHerdrRunningInTerminal(mockTerminal);
            expect(result).to.be.false;
        });

        it('returns true when child process is herdr', async () => {
            mockStdout = [
                'PPID   PID COMM',
                '   1   100 /bin/zsh',
                ' 100   101 herdr'
            ].join('\n');

            const mockTerminal: any = {
                name: 'Herdr (vscode)',
                exitStatus: undefined,
                processId: Promise.resolve(100)
            };
            const result = await isHerdrRunningInTerminal(mockTerminal);
            expect(result).to.be.true;
        });

        it('returns false when child process is an idle shell or other tool', async () => {
            mockStdout = [
                'PPID   PID COMM',
                '   1   100 /bin/zsh',
                ' 100   101 /bin/bash'
            ].join('\n');

            const mockTerminal: any = {
                name: 'Herdr (vscode)',
                exitStatus: undefined,
                processId: Promise.resolve(100)
            };
            const result = await isHerdrRunningInTerminal(mockTerminal);
            expect(result).to.be.false;
        });
    });

    describe('captureTerminalOutputWithClipboard', () => {
        it('returns selected text even when selection matches original clipboard content without falling back to selectAll', async () => {
            let clipboardValue = 'Build failed at line 42';
            const executedCommands: string[] = [];
            const mockClipboard = {
                readText: async () => clipboardValue,
                writeText: async (v: string) => { clipboardValue = v; }
            };

            const result = await captureTerminalOutputWithClipboard(mockClipboard, async (cmd: string) => {
                executedCommands.push(cmd);
                if (cmd === 'workbench.action.terminal.copySelection') {
                    // Simulate terminal selection copying the exact same string as original clipboard
                    clipboardValue = 'Build failed at line 42';
                }
            });

            expect(result).to.equal('Build failed at line 42');
            expect(executedCommands).to.deep.equal(['workbench.action.terminal.copySelection']);
            expect(clipboardValue).to.equal('Build failed at line 42');
        });

        it('falls back to selectAll when no terminal selection is present and restores clipboard', async () => {
            let clipboardValue = 'prior clipboard';
            const executedCommands: string[] = [];
            let hasTerminalSelection = false;
            const mockClipboard = {
                readText: async () => clipboardValue,
                writeText: async (v: string) => { clipboardValue = v; }
            };

            const result = await captureTerminalOutputWithClipboard(mockClipboard, async (cmd: string) => {
                executedCommands.push(cmd);
                if (cmd === 'workbench.action.terminal.selectAll') {
                    hasTerminalSelection = true;
                } else if (cmd === 'workbench.action.terminal.copySelection' && hasTerminalSelection) {
                    clipboardValue = 'full terminal buffer output';
                } else if (cmd === 'workbench.action.terminal.clearSelection') {
                    hasTerminalSelection = false;
                }
            });

            expect(result).to.equal('full terminal buffer output');
            expect(executedCommands).to.deep.equal([
                'workbench.action.terminal.copySelection',
                'workbench.action.terminal.selectAll',
                'workbench.action.terminal.copySelection',
                'workbench.action.terminal.clearSelection'
            ]);
            expect(clipboardValue).to.equal('prior clipboard');
        });
    });

    describe('Multi-root Git Context Resolution', () => {
        let tempRootA: string;
        let tempRootB: string;

        beforeEach(() => {
            resetMockState();
            tempRootA = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-multi-a-'));
            tempRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-multi-b-'));
            (cp as any).execFile = originalExecFile;
        });

        afterEach(() => {
            delete (mockVscode.workspace as any).workspaceFolders;
            try {
                fs.rmSync(tempRootA, { recursive: true, force: true });
                fs.rmSync(tempRootB, { recursive: true, force: true });
            } catch {}
        });

        it('resolves repo root and clean repo-relative file path for resources in secondary workspace folders', async () => {
            fs.mkdirSync(path.join(tempRootB, 'src'), { recursive: true });
            const fileInB = path.join(tempRootB, 'src', 'worker.ts');
            fs.writeFileSync(fileInB, 'export {};\n', 'utf8');

            // Make tempRootB an actual git repository so getRepoRoot succeeds
            cp.execFileSync('git', ['init'], { cwd: tempRootB });

            (mockVscode.workspace as any).workspaceFolders = [
                { uri: mockVscode.Uri.file(tempRootA), name: 'frontend', index: 0 },
                { uri: mockVscode.Uri.file(tempRootB), name: 'backend', index: 1 }
            ];

            const resolvedRoot = await fs.promises.realpath(tempRootB);
            const symlinkFile = path.join(tempRootB, 'src', 'worker.ts');
            const ctx = await resolveGitContextForUri(mockVscode.Uri.file(symlinkFile) as any);

            expect(ctx).to.not.be.null;
            expect(ctx!.cwd).to.equal(resolvedRoot);
            expect(ctx!.targetFile).to.equal('src/worker.ts');
            expect(computeGitRelativePath(resolvedRoot, symlinkFile)).to.equal('src/worker.ts');
        });
    });
});
