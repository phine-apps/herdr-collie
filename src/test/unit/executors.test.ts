/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as cp from 'child_process';
import { execHerdr, runGitCmd, getSessionSocketPath, ensureSessionServerRunning, isCommandAvailable } from '../../executors';

describe('executors Unit Tests', () => {
    let originalExecFile: any;
    let recordedCalls: { file: string; args: string[]; options: any }[] = [];
    let mockError: any = null;
    let mockStdout = '{"result": {}}';
    let mockStderr = '';

    beforeEach(() => {
        recordedCalls = [];
        mockError = null;
        mockStdout = '{"result": {}}';
        mockStderr = '';
        originalExecFile = cp.execFile;
        // Mock cp.execFile
        (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
            let options = typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
            let cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
            recordedCalls.push({ file, args, options });
            if (cb) {
                cb(mockError, mockStdout, mockStderr);
            }
            return {} as any;
        };
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
    });

    describe('execHerdr', () => {
        it('should invoke herdr binary via execFile with exact argument arrays', (done) => {
            execHerdr(['workspace', 'list'], (err: any, stdout: any) => {
                expect(err).to.be.null;
                expect(recordedCalls).to.have.lengthOf(1);
                expect(recordedCalls[0].file).to.equal('herdr');
                expect(recordedCalls[0].args).to.deep.equal(['workspace', 'list']);
                done();
            });
        });

        it('should execute synchronously without callback', () => {
            execHerdr(['agent', 'list']);
            expect(recordedCalls).to.have.lengthOf(1);
            expect(recordedCalls[0].args).to.deep.equal(['agent', 'list']);
        });

        it('should merge options and preserve custom env while removing HERDR variables', (done) => {
            process.env['HERDR_WORKSPACE'] = 'nested-ws';
            process.env['HERDR_PANE_ID'] = 'pane-123';
            process.env['HERDR_AGENT'] = 'agent-xyz';

            const customOptions = { cwd: '/custom/dir', env: { CUSTOM_VAR: 'value' } };

            execHerdr(['workspace', 'create'], customOptions, (err: any, stdout: any) => {
                expect(err).to.be.null;
                expect(recordedCalls).to.have.lengthOf(1);
                const opts = recordedCalls[0].options;
                expect(opts.cwd).to.equal('/custom/dir');
                expect(opts.env.CUSTOM_VAR).to.equal('value');
                expect(opts.env).to.not.have.property('HERDR_WORKSPACE');
                expect(opts.env).to.not.have.property('HERDR_PANE_ID');
                expect(opts.env).to.not.have.property('HERDR_AGENT');

                delete process.env['HERDR_WORKSPACE'];
                delete process.env['HERDR_PANE_ID'];
                delete process.env['HERDR_AGENT'];
                done();
            });
        });

        it('should pass strings with shell injection characters safely as literal arguments', (done) => {
            const maliciousPayload = 'test"; $(whoami); `rm -rf /` && echo "pwned';
            execHerdr(['agent', 'prompt', 'agent-1', maliciousPayload], (err: any, stdout: any) => {
                expect(err).to.be.null;
                expect(recordedCalls).to.have.lengthOf(1);
                expect(recordedCalls[0].args).to.deep.equal([
                    'agent',
                    'prompt',
                    'agent-1',
                    maliciousPayload
                ]);
                expect(recordedCalls[0].args[3]).to.equal(maliciousPayload);
                done();
            });
        });
    });

    describe('runGitCmd', () => {
        it('should execute git command with arguments and resolve stdout', async () => {
            mockStdout = 'main\n';
            const result = await runGitCmd(['branch', '--show-current'], '/repo');
            expect(result).to.equal('main\n');
            expect(recordedCalls[0].file).to.equal('git');
            expect(recordedCalls[0].args).to.deep.equal(['branch', '--show-current']);
            expect(recordedCalls[0].options.cwd).to.equal('/repo');
        });

        it('should reject with helpful error message when Git is missing', async () => {
            mockError = { code: 'ENOENT', message: 'spawn git ENOENT' };
            try {
                await runGitCmd(['status'], '/repo');
                expect.fail('Should have rejected');
            } catch (err: any) {
                expect(err.message).to.include('Git CLI is not installed or not in PATH');
            }
        });

        it('should resolve stdout even if non-zero exit code occurs for non-fatal diff', async () => {
            mockError = { code: 1, message: 'diff found' };
            mockStdout = 'diff output here';
            const result = await runGitCmd(['diff'], '/repo');
            expect(result).to.equal('diff output here');
        });

        it('should reject non-diff commands when exit code is non-zero', async () => {
            mockError = { code: 1, message: 'Command failed' };
            mockStderr = 'fatal: merge conflict';
            try {
                await runGitCmd(['merge', '--', 'feature-branch'], '/repo');
                expect.fail('Should have rejected non-diff command');
            } catch (err: any) {
                expect(err.message).to.include('fatal: merge conflict');
            }
        });
    });

    describe('getSessionSocketPath', () => {
        let origSocketPath: string | undefined;
        let origSession: string | undefined;

        beforeEach(() => {
            origSocketPath = process.env['HERDR_SOCKET_PATH'];
            origSession = process.env['HERDR_SESSION'];
            delete process.env['HERDR_SOCKET_PATH'];
            delete process.env['HERDR_SESSION'];
        });

        afterEach(() => {
            if (origSocketPath !== undefined) {
                process.env['HERDR_SOCKET_PATH'] = origSocketPath;
            } else {
                delete process.env['HERDR_SOCKET_PATH'];
            }
            if (origSession !== undefined) {
                process.env['HERDR_SESSION'] = origSession;
            } else {
                delete process.env['HERDR_SESSION'];
            }
        });

        it('resolves default socket path', () => {
            expect(getSessionSocketPath()).to.include('herdr.sock');
            expect(getSessionSocketPath('default')).to.include('herdr.sock');
        });

        it('resolves custom session socket path', () => {
            expect(getSessionSocketPath('vscode')).to.include('sessions/vscode/herdr.sock');
        });
    });

    describe('isCommandAvailable', () => {
        it('returns false for empty binary name', async () => {
            const available = await isCommandAvailable('');
            expect(available).to.be.false;
        });

        it('returns true when which/where succeeds', async () => {
            mockError = null;
            const available = await isCommandAvailable('claude');
            expect(available).to.be.true;
            expect(recordedCalls[0].args).to.deep.equal(['claude']);
        });

        it('returns false when binary is not found', async () => {
            mockError = new Error('not found');
            const available = await isCommandAvailable('nonexistent-tool');
            expect(available).to.be.false;
        });

        it('executes custom check arguments when provided', async () => {
            mockError = null;
            const available = await isCommandAvailable('gh', ['copilot', '--help']);
            expect(available).to.be.true;
            expect(recordedCalls[0].file).to.equal('gh');
            expect(recordedCalls[0].args).to.deep.equal(['copilot', '--help']);
        });
    });
});

