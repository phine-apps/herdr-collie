/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as cp from 'child_process';
import { isHerdrRunningInTerminal } from '../../extension';

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
});
