/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { HerdrSocketClient, getSessionSocketPath, validateSessionName, sanitizeSessionName, normalizeConfiguredSessionName, isSafeCliTargetId } from '../../socketClient';

function getTestSocketDir(): string {
    return process.env['HERDR_TEST_SOCKET_DIR'] || os.tmpdir();
}

function assertUnixSocketSupported(sockDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const probePath = path.join(sockDir, `herdr-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
        const probeServer = net.createServer((s) => s.destroy());
        const cleanup = () => {
            try { probeServer.close(); } catch {}
            try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch {}
        };
        probeServer.once('error', (err: NodeJS.ErrnoException) => {
            cleanup();
            reject(new Error(`Unix domain socket unavailable in test environment (${err.code || err.message}). Run outside sandbox or set HERDR_TEST_SOCKET_DIR.`));
        });
        probeServer.listen(probePath, () => {
            const client = net.createConnection(probePath);
            client.once('connect', () => {
                client.destroy();
                cleanup();
                resolve();
            });
            client.once('error', (err: NodeJS.ErrnoException) => {
                client.destroy();
                cleanup();
                reject(new Error(`Unix domain socket connection blocked in test environment (${err.code || err.message}). Run outside sandbox or set HERDR_TEST_SOCKET_DIR.`));
            });
        });
    });
}

describe('HerdrSocketClient Unit Tests', function() {
    this.timeout(10000);

    describe('Socket Transport Tests', function() {
        let mockServer: net.Server;
        let tempSockPath: string;
        let activeSockets: Set<net.Socket> = new Set();
        let lastClientSocket: net.Socket | null = null;
        let receivedServerData: string[] = [];
        const createdClients: HerdrSocketClient[] = [];

        const createClient = (socketPathOrSession?: string): HerdrSocketClient => {
            const client = socketPathOrSession && (socketPathOrSession.includes('/') || socketPathOrSession.includes('\\'))
                ? HerdrSocketClient.fromSocketPath(socketPathOrSession)
                : new HerdrSocketClient(socketPathOrSession);
            createdClients.push(client);
            return client;
        };

        before(async () => {
            await assertUnixSocketSupported(getTestSocketDir());
        });

        beforeEach((done) => {
            receivedServerData = [];
            activeSockets.clear();
            tempSockPath = path.join(getTestSocketDir(), `herdr-test-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

            mockServer = net.createServer((socket) => {
            activeSockets.add(socket);
            lastClientSocket = socket;
            socket.on('close', () => activeSockets.delete(socket));
            socket.on('error', () => {}); // Ignore client disconnect errors
            socket.on('data', (data) => {
                const str = data.toString();
                receivedServerData.push(str);
                const lines = str.split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (!socket.destroyed) {
                            if (msg.method === 'events.subscribe') {
                                socket.write(JSON.stringify({ id: msg.id, result: { subscribed: true } }) + '\n');
                            } else if (msg.method === 'session.snapshot') {
                                socket.write(JSON.stringify({
                                    id: msg.id,
                                    result: {
                                        snapshot: {
                                            workspaces: [
                                                { workspace_id: 'ws-sock-1', label: 'SockWS', focused: true }
                                            ],
                                            agents: [
                                                { id: 'agent-sock-1', name: 'Bot', status: 'running' }
                                            ]
                                        }
                                    }
                                }) + '\n');
                            } else if (msg.method === 'pane.send_keys' || msg.method === 'pane.send_text' || msg.method === 'pane.send_input' || msg.method === 'agent.send_keys' || msg.method === 'agent.prompt') {
                                socket.write(JSON.stringify({ id: msg.id, result: { success: true } }) + '\n');
                            } else if (msg.method === 'integration.list') {
                                socket.write(JSON.stringify({
                                    id: msg.id,
                                    result: {
                                        integrations: [
                                            { target: 'claude', installed: true, current: true },
                                            { target: 'antigravity_cli', installed: true, current: false }
                                        ]
                                    }
                                }) + '\n');
                            } else if (
                                msg.method === 'integration.install'
                                || msg.method === 'agent.start'
                                || msg.method === 'worktree.create'
                                || msg.method === 'workspace.create'
                                || msg.method === 'pane.split'
                            ) {
                                socket.write(JSON.stringify({ id: msg.id, result: { echoed: msg.params } }) + '\n');
                            } else if (msg.method === 'fail.method') {
                                socket.write(JSON.stringify({
                                    id: msg.id,
                                    error: { code: 'test_error', message: 'Test failure' }
                                }) + '\n');
                            }
                        }
                    } catch (e) {}
                }
            });
        });

        mockServer.once('error', (err) => done(err));
        mockServer.listen(tempSockPath, () => done());
    });

    afterEach(async () => {
        while (createdClients.length > 0) {
            try {
                createdClients.pop()!.dispose();
            } catch {}
        }

        for (const sock of activeSockets) {
            try {
                sock.destroy();
            } catch (e) {}
        }
        activeSockets.clear();

        if (mockServer) {
            await Promise.race([
                new Promise<void>((resolve) => {
                    mockServer.close(() => {
                        try {
                            if (fs.existsSync(tempSockPath)) {
                                fs.unlinkSync(tempSockPath);
                            }
                        } catch (e) {}
                        resolve();
                    });
                }),
                new Promise<void>((resolve) => setTimeout(resolve, 1000))
            ]);
        }
    });

    it('connects to socket and automatically subscribes to events', (done) => {
        const client = createClient(tempSockPath);
        client.on('connect', () => {
            expect(client.isConnected).to.be.true;
            // Allow small tick for subscribe message to be processed
            setTimeout(() => {
                const subscribeCall = receivedServerData.some(d => d.includes('events.subscribe'));
                expect(subscribeCall).to.be.true;
                client.dispose();
                done();
            }, 50);
        });
        client.connect();
    });

    it('fetches session.snapshot successfully', async () => {
        const client = createClient(tempSockPath);
        await new Promise<void>((resolve) => {
            client.on('connect', () => resolve());
            client.connect();
        });

        const snapshot = await client.getSnapshot();
        expect(snapshot).to.not.be.null;
        expect(snapshot?.workspaces).to.have.lengthOf(1);
        expect(snapshot?.workspaces?.[0].workspace_id).to.equal('ws-sock-1');
        expect(snapshot?.agents).to.have.lengthOf(1);
        expect(snapshot?.agents?.[0].status).to.equal('running');

        client.dispose();
    });

    it('receives pushed events and emits event signal', (done) => {
        const client = createClient(tempSockPath);
        client.on('event', (ev: any) => {
            expect(ev.type).to.equal('workspace_updated');
            expect(ev.workspace_id).to.equal('ws-sock-1');
            client.dispose();
            done();
        });

        client.on('connect', () => {
            setTimeout(() => {
                if (lastClientSocket) {
                    lastClientSocket.write(JSON.stringify({
                        type: 'workspace_updated',
                        workspace_id: 'ws-sock-1'
                    }) + '\n');
                }
            }, 30);
        });

        client.connect();
    });

    it('handles request errors properly', async () => {
        const client = createClient(tempSockPath);
        await new Promise<void>((resolve) => {
            client.on('connect', () => resolve());
            client.connect();
        });

        try {
            await client.request('fail.method', {});
            expect.fail('Should have failed');
        } catch (e: any) {
            expect(e.message).to.include('Test failure');
        } finally {
            client.dispose();
        }
    });

    it('sends pane keys, agent keys, and pane input successfully', async () => {
        const client = createClient(tempSockPath);
        await new Promise<void>((resolve) => {
            client.on('connect', () => resolve());
            client.connect();
        });

        const resKeys = await client.sendPaneKeys('w1:p1', ['y', 'enter']);
        expect(resKeys).to.deep.equal({ success: true });

        const resAgentKeys = await client.sendAgentKeys('bot-1', ['n', 'enter']);
        expect(resAgentKeys).to.deep.equal({ success: true });

        const resInput = await client.sendPaneInput('w1:p1', 'hello', ['enter']);
        expect(resInput).to.deep.equal({ success: true });

        client.dispose();
    });

    it('cleans up and rejects pending requests on dispose', async () => {
        const client = createClient(tempSockPath);
        await new Promise<void>((resolve) => {
            client.on('connect', () => resolve());
            client.connect();
        });

        const reqPromise = client.request('non_existent_long_method', {}, 10000);
        client.dispose();

        try {
            await reqPromise;
            expect.fail('Should have rejected');
        } catch (e: any) {
            expect(e.message).to.include('disposed');
        }
    });

    it('supports Protocol 22 integration, agent.start, and worktree.create RPCs', async () => {
        const client = createClient(tempSockPath);
        await new Promise<void>((resolve) => {
            client.on('connect', () => resolve());
            client.connect();
        });

        const integrations = await client.listIntegrations();
        expect(integrations).to.have.lengthOf(2);
        expect(integrations[1].target).to.equal('antigravity_cli');

        const installedRes = await client.installIntegration('antigravity-cli');
        expect(installedRes.echoed).to.deep.equal({ target: 'antigravity_cli' });

        const startedRes = await client.startAgent({ name: 'feat-a', kind: 'claude', paneId: 'w1:p1', timeoutMs: 25000 });
        expect(startedRes.echoed).to.deep.equal({
            name: 'feat-a',
            kind: 'claude',
            pane_id: 'w1:p1',
            timeout_ms: 25000
        });

        const wtRes = await client.createWorktree({ branch: 'feat/test', base: 'main' });
        expect(wtRes.echoed).to.deep.include({ branch: 'feat/test', base: 'main', focus: false, trust_repository: false });

        const wsRes = await client.createWorkspace({ cwd: '/tmp/wt', label: 'feat/test', focus: true });
        expect(wsRes.echoed).to.deep.equal({ cwd: '/tmp/wt', label: 'feat/test', focus: true });

        const splitRes = await client.splitPane({ direction: 'right', targetPaneId: 'w1:p1', cwd: '/tmp/wt', focus: false });
        expect(splitRes.echoed).to.deep.equal({ direction: 'right', target_pane_id: 'w1:p1', cwd: '/tmp/wt', focus: false });

        client.dispose();
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

        it('resolves default socket path when no session or default is provided', () => {
            const expected = path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
            expect(getSessionSocketPath()).to.equal(expected);
            expect(getSessionSocketPath('default')).to.equal(expected);
        });

        it('resolves named session socket path', () => {
            const expected = path.join(os.homedir(), '.config', 'herdr', 'sessions', 'vscode', 'herdr.sock');
            expect(getSessionSocketPath('vscode')).to.equal(expected);
        });

        it('honors HERDR_SOCKET_PATH env when no session is explicitly provided', () => {
            process.env['HERDR_SOCKET_PATH'] = '/custom/path/to/herdr.sock';
            expect(getSessionSocketPath()).to.equal('/custom/path/to/herdr.sock');
        });

        it('honors HERDR_SOCKET_PATH when session matches HERDR_SESSION', () => {
            process.env['HERDR_SOCKET_PATH'] = '/custom/path/to/herdr.sock';
            process.env['HERDR_SESSION'] = 'test-session';
            expect(getSessionSocketPath('test-session')).to.equal('/custom/path/to/herdr.sock');
            // But if asking for different session, resolves that session's path
            expect(getSessionSocketPath('other-session')).to.equal(path.join(os.homedir(), '.config', 'herdr', 'sessions', 'other-session', 'herdr.sock'));
        });

        it('sanitizes malicious session names to prevent directory traversal', () => {
            const result = getSessionSocketPath('../../tmp/malicious');
            expect(result).to.not.include('..');
            expect(result).to.equal(path.join(os.homedir(), '.config', 'herdr', 'sessions', 'malicious', 'herdr.sock'));
        });
    });

    describe('validateSessionName', () => {
        it('rejects empty or whitespace-only session names', () => {
            expect(validateSessionName('')).to.equal('Session name cannot be empty');
            expect(validateSessionName('   ')).to.equal('Session name cannot be empty');
        });

        it('rejects session names starting with a hyphen', () => {
            expect(validateSessionName('-session')).to.equal('Session name cannot start with a hyphen (-)');
            expect(validateSessionName('--flag')).to.equal('Session name cannot start with a hyphen (-)');
        });

        it('rejects session names with path traversal or invalid characters', () => {
            expect(validateSessionName('../evil')).to.include('can only contain alphanumeric');
            expect(validateSessionName('my session')).to.include('can only contain alphanumeric');
            expect(validateSessionName('sess/1')).to.include('can only contain alphanumeric');
            expect(validateSessionName('sess;rm')).to.include('can only contain alphanumeric');
        });

        it('accepts valid session names', () => {
            expect(validateSessionName('default')).to.be.null;
            expect(validateSessionName('vscode')).to.be.null;
            expect(validateSessionName('project_1')).to.be.null;
            expect(validateSessionName('backend-api-2')).to.be.null;
        });
    });

    describe('sanitizeSessionName', () => {
        it('strips leading hyphens and disallowed characters while keeping valid characters', () => {
            expect(sanitizeSessionName('-foo')).to.equal('foo');
            expect(sanitizeSessionName('--flag;rm -rf')).to.equal('flagrm-rf');
            expect(sanitizeSessionName('---')).to.equal('');
            expect(sanitizeSessionName('  my_session-2  ')).to.equal('my_session-2');
            expect(sanitizeSessionName(undefined)).to.equal('');
        });
    });

    describe('normalizeConfiguredSessionName', () => {
        it('returns valid trimmed session names and falls back on unsafe or invalid inputs', () => {
            expect(normalizeConfiguredSessionName('  feature_1-dev  ')).to.equal('feature_1-dev');
            expect(normalizeConfiguredSessionName('--evil')).to.equal('vscode');
            expect(normalizeConfiguredSessionName('../escape')).to.equal('vscode');
            expect(normalizeConfiguredSessionName('with spaces')).to.equal('vscode');
            expect(normalizeConfiguredSessionName('')).to.equal('vscode');
            expect(normalizeConfiguredSessionName(undefined, 'default')).to.equal('default');
        });
    });

    describe('Session Validation, Target Guards & Missing-Daemon Backoff', () => {
        it('rejects path-like or unsafe session names in new HerdrSocketClient while allowing fromSocketPath()', () => {
            expect(() => new HerdrSocketClient('/tmp/herdr.sock')).to.throw();
            expect(() => new HerdrSocketClient('../evil')).to.throw();
            expect(() => new HerdrSocketClient('--flag')).to.throw();
            expect(() => HerdrSocketClient.fromSocketPath('')).to.throw();

            const direct = HerdrSocketClient.fromSocketPath(path.join(getTestSocketDir(), 'valid.sock'));
            expect(direct).to.be.instanceOf(HerdrSocketClient);
            direct.dispose();
        });

        it('validates CLI target IDs via isSafeCliTargetId', () => {
            expect(isSafeCliTargetId('w1:p1')).to.be.true;
            expect(isSafeCliTargetId('tab-1_main')).to.be.true;
            expect(isSafeCliTargetId('-evil')).to.be.false;
            expect(isSafeCliTargetId('--option')).to.be.false;
            expect(isSafeCliTargetId('id;rm -rf /')).to.be.false;
            expect(isSafeCliTargetId('id with space')).to.be.false;
            expect(isSafeCliTargetId('')).to.be.false;
            expect(isSafeCliTargetId(null)).to.be.false;
        });

        it('does not emit disconnect before first successful connection and supports retryNow()', async () => {
            const missingSock = path.join(getTestSocketDir(), `herdr-missing-${Date.now()}.sock`);
            const client = HerdrSocketClient.fromSocketPath(missingSock);
            let disconnectCount = 0;
            let errorCount = 0;
            client.on('disconnect', () => { disconnectCount++; });
            client.on('error', () => { errorCount++; });

            try {
                client.connect();
                await new Promise(resolve => setTimeout(resolve, 60));
                expect(disconnectCount).to.equal(0);
                expect(errorCount).to.be.greaterThan(0);

                const prevErrors = errorCount;
                client.retryNow();
                await new Promise(resolve => setTimeout(resolve, 60));
                expect(errorCount).to.be.greaterThan(prevErrors);
                expect(disconnectCount).to.equal(0);
            } finally {
                client.dispose();
            }
        });
    });
});

