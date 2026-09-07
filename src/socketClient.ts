/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

export interface HerdrSnapshotWorkspace {
    workspace_id: string;
    number?: number;
    label?: string;
    focused?: boolean;
    pane_count?: number;
    tab_count?: number;
    active_tab_id?: string;
    agent_status?: string;
}

export interface HerdrSnapshotPane {
    pane_id: string;
    workspace_id: string;
    tab_id?: string;
    focused?: boolean;
    cwd?: string;
    foreground_cwd?: string;
    agent_status?: string;
    command?: string;
    name?: string;
}

export interface HerdrSnapshotAgent {
    id?: string;
    name?: string;
    agent?: string;
    pane_id?: string;
    status?: string;
    agent_status?: string;
}

export interface HerdrSessionSnapshot {
    version?: string;
    protocol?: number;
    focused_workspace_id?: string;
    focused_tab_id?: string;
    focused_pane_id?: string;
    workspaces?: HerdrSnapshotWorkspace[];
    tabs?: any[];
    panes?: HerdrSnapshotPane[];
    layouts?: any[];
    agents?: HerdrSnapshotAgent[];
}

/**
 * Validates a session name for safe CLI usage and filesystem safety.
 */
export function validateSessionName(name: string): string | null {
    if (!name || !name.trim()) return 'Session name cannot be empty';
    const trimmed = name.trim();
    if (trimmed.startsWith('-')) return 'Session name cannot start with a hyphen (-)';
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return 'Session name can only contain alphanumeric characters, underscores, and hyphens';
    }
    return null;
}

/**
 * Resolves the socket path for a given session name.
 */
export function getSessionSocketPath(sessionName?: string): string {
    if (!sessionName || sessionName === 'default') {
        if (!sessionName && process.env['HERDR_SOCKET_PATH']) {
            return process.env['HERDR_SOCKET_PATH'];
        }
        return path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
    }
    if (process.env['HERDR_SESSION'] === sessionName && process.env['HERDR_SOCKET_PATH']) {
        return process.env['HERDR_SOCKET_PATH'];
    }
    // Sanitize sessionName to prevent path traversal
    const safeSessionName = path.basename(sessionName).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(os.homedir(), '.config', 'herdr', 'sessions', safeSessionName || 'default', 'herdr.sock');
}

export interface HerdrSocketClientEvents {
    connect: () => void;
    disconnect: () => void;
    event: (message: unknown) => void;
    error: (err: Error) => void;
}

export declare interface HerdrSocketClient {
    on<K extends keyof HerdrSocketClientEvents>(event: K, listener: HerdrSocketClientEvents[K]): this;
    once<K extends keyof HerdrSocketClientEvents>(event: K, listener: HerdrSocketClientEvents[K]): this;
    off<K extends keyof HerdrSocketClientEvents>(event: K, listener: HerdrSocketClientEvents[K]): this;
}

export class HerdrSocketClient extends EventEmitter {
    private socket: net.Socket | null = null;
    private socketPath: string;
    private pendingRequests: Map<string, { resolve: (res: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = new Map();
    private buffer = '';
    private requestIdCounter = 1;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isDisposed = false;
    private _isConnected = false;

    constructor(customSocketPathOrSession?: string) {
        super();
        if (customSocketPathOrSession && (customSocketPathOrSession.includes('/') || customSocketPathOrSession.includes('\\'))) {
            this.socketPath = customSocketPathOrSession;
        } else {
            this.socketPath = getSessionSocketPath(customSocketPathOrSession);
        }

        // Register default no-op error handler to prevent Node.js unhandled 'error' event crash
        this.on('error', () => {});
    }

    public get isConnected(): boolean {
        return this._isConnected;
    }

    public connect(): void {
        if (this.isDisposed || this.socket) return;

        try {
            this.socket = net.createConnection(this.socketPath);
            
            this.socket.on('connect', () => {
                this._isConnected = true;
                this.emit('connect');
                // Subscribe to events automatically upon connection
                this.request('events.subscribe', {}).catch(() => {});
            });

            this.socket.on('data', (data: Buffer) => {
                this.handleData(data.toString());
            });

            this.socket.on('error', (err: Error) => {
                this._isConnected = false;
                this.emit('error', err);
            });

            this.socket.on('close', () => {
                this._isConnected = false;
                this.socket = null;
                this.rejectAllPending(new Error('Herdr socket connection closed'));
                this.emit('disconnect');
                this.scheduleReconnect();
            });
        } catch (e: any) {
            this._isConnected = false;
            this.socket = null;
            this.emit('error', e);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(delayMs = 5000): void {
        if (this.isDisposed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delayMs);
    }

    private handleData(chunk: string): void {
        this.buffer += chunk;
        if (this.buffer.length > 5 * 1024 * 1024) {
            // Prevent unbounded buffer accumulation
            this.buffer = '';
            return;
        }
        const lines = this.buffer.split('\n');
        // Keep unfinished trailing chunk in buffer
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const message = JSON.parse(trimmed);
                this.handleMessage(message);
            } catch (e) {
                // Ignore parse errors on malformed chunks
            }
        }
    }

    private handleMessage(message: any): void {
        // If message has an ID matching a pending request, resolve/reject it
        if (message.id && this.pendingRequests.has(message.id)) {
            const pending = this.pendingRequests.get(message.id)!;
            clearTimeout(pending.timer);
            this.pendingRequests.delete(message.id);

            if (message.error) {
                pending.reject(new Error(message.error.message || message.error.code || 'Herdr API error'));
            } else {
                pending.resolve(message.result !== undefined ? message.result : message);
            }
            return;
        }

        // Otherwise, it is an event or broadcast notification
        this.emit('event', message);
    }

    public request<T = any>(method: string, params: any = {}, timeoutMs = 5000): Promise<T> {
        if (!this.socket || !this._isConnected) {
            return Promise.reject(new Error('Not connected to Herdr socket'));
        }

        const id = `collie_${this.requestIdCounter++}`;
        const payload = JSON.stringify({ id, method, params }) + '\n';

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Herdr socket request timed out for method '${method}'`));
                }
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timer });

            this.socket!.write(payload, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }

    public async getSnapshot(): Promise<HerdrSessionSnapshot | null> {
        try {
            const res = await this.request<{ snapshot: HerdrSessionSnapshot }>('session.snapshot', {});
            return res.snapshot || (res as any) || null;
        } catch {
            return null;
        }
    }

    /**
     * Sends key presses (e.g. ['y', 'enter']) to a target pane via socket
     */
    public async sendPaneKeys(paneId: string, keys: string[]): Promise<any> {
        return await this.request('pane.send_keys', { pane_id: paneId, keys });
    }

    /**
     * Sends key presses to an agent target via socket
     */
    public async sendAgentKeys(agentId: string, keys: string[]): Promise<any> {
        return await this.request('agent.send_keys', { target: agentId, keys });
    }

    /**
     * Sends raw input text/keystrokes to a target pane via socket
     */
    public async sendPaneInput(paneId: string, text: string, keys?: string[]): Promise<any> {
        try {
            return await this.request('pane.send_input', {
                pane_id: paneId,
                text,
                ...(keys && keys.length > 0 ? { keys } : {})
            });
        } catch {
            if (keys && keys.length > 0) {
                await this.request('pane.send_text', { pane_id: paneId, text });
                return await this.request('pane.send_keys', { pane_id: paneId, keys });
            }
            return await this.request('pane.send_text', { pane_id: paneId, text });
        }
    }

    /**
     * Sends prompt to an agent via socket
     */
    public async sendAgentPrompt(agentIdOrPaneId: string, prompt: string): Promise<any> {
        return await this.request('agent.prompt', { agent: agentIdOrPaneId, prompt });
    }

    private rejectAllPending(err: Error): void {
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pendingRequests.clear();
    }

    public dispose(): void {
        this.isDisposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.rejectAllPending(new Error('HerdrSocketClient disposed'));
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this._isConnected = false;
        this.removeAllListeners();
    }
}
