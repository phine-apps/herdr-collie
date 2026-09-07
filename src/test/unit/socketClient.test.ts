/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { HerdrSocketClient, getSessionSocketPath, validateSessionName } from '../../socketClient';

describe('HerdrSocketClient Unit Tests', () => {
    let mockServer: net.Server;
    let tempSockPath: string;
    let lastClientSocket: net.Socket | null = null;
    let receivedServerData: string[] = [];

    beforeEach((done) => {
        receivedServerData = [];
        tempSockPath = path.join(os.tmpdir(), `herdr-test-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

        mockServer = net.createServer((socket) => {
            lastClientSocket = socket;
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

        mockServer.listen(tempSockPath, () => done());
    });

    afterEach(async () => {
        if (mockServer) {
            await new Promise<void>((resolve) => {
                mockServer.close(() => {
                    try {
                        if (fs.existsSync(tempSockPath)) {
                            fs.unlinkSync(tempSockPath);
                        }
                    } catch (e) {}
                    resolve();
                });
            });
        }
    });

    it('connects to socket and automatically subscribes to events', (done) => {
        const client = new HerdrSocketClient(tempSockPath);
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
        const client = new HerdrSocketClient(tempSockPath);
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
        const client = new HerdrSocketClient(tempSockPath);
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
        const client = new HerdrSocketClient(tempSockPath);
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
        const client = new HerdrSocketClient(tempSockPath);
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
        const client = new HerdrSocketClient(tempSockPath);
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
});

