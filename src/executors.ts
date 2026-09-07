/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as cp from 'child_process';
import * as net from 'net';
import { getSessionSocketPath } from './socketClient';

export { getSessionSocketPath };


const activeServerStartPromises = new Map<string, Promise<boolean>>();

/**
 * Checks if the session server daemon is running, and spawns it in the background if not.
 */
export async function ensureSessionServerRunning(sessionName: string = 'default'): Promise<boolean> {
    if (activeServerStartPromises.has(sessionName)) {
        return await activeServerStartPromises.get(sessionName)!;
    }

    const startPromise = (async () => {
        const socketPath = getSessionSocketPath(sessionName);
        
        // Check if socket is already listening
        const isAlive = await new Promise<boolean>((resolve) => {
            const testSock = net.createConnection(socketPath);
            testSock.on('connect', () => {
                testSock.destroy();
                resolve(true);
            });
            testSock.on('error', () => {
                resolve(false);
            });
        });

        if (isAlive) {
            return true;
        }

        // Prepare clean environment for server spawn
        const env = Object.assign({}, process.env);
        delete env['HERDR_WORKSPACE'];
        delete env['HERDR_PANE_ID'];
        delete env['HERDR_PANE'];
        delete env['HERDR_AGENT'];
        delete env['HERDR_SESSION'];
        if (process.env['HERDR_CONFIG_PATH']) {
            env['HERDR_CONFIG_PATH'] = process.env['HERDR_CONFIG_PATH'];
        }

        const args = sessionName && sessionName !== 'default' 
            ? ['--session', sessionName, 'server'] 
            : ['server'];

        try {
            const child = cp.spawn('herdr', args, {
                detached: true,
                stdio: 'ignore',
                env
            });
            child.unref();

            // Wait for socket to become available (poll up to 2.5 seconds)
            const startTime = Date.now();
            while (Date.now() - startTime < 2500) {
                await new Promise(r => setTimeout(r, 100));
                const ready = await new Promise<boolean>((resolve) => {
                    const s = net.createConnection(socketPath);
                    s.on('connect', () => {
                        s.destroy();
                        resolve(true);
                    });
                    s.on('error', () => {
                        resolve(false);
                    });
                });
                if (ready) {
                    return true;
                }
            }
        } catch (e) {
            console.error(`[herdr-collie] Failed to auto-start Herdr server for session ${sessionName}:`, e);
        }

        return false;
    })();

    activeServerStartPromises.set(sessionName, startPromise);
    try {
        return await startPromise;
    } finally {
        activeServerStartPromises.delete(sessionName);
    }
}

// -----------------------------------------------------------------------------
// Utility: Run herdr CLI without inheriting nested environment variables
// -----------------------------------------------------------------------------
export function execHerdr(
    args: string[], 
    optionsOrCallback?: any, 
    callback?: any
) {
    const env = Object.assign({}, process.env);
    // Remove existing Herdr environment variables to avoid nesting limits
    delete env['HERDR_WORKSPACE'];
    delete env['HERDR_PANE_ID'];
    delete env['HERDR_PANE'];
    delete env['HERDR_AGENT'];
    delete env['HERDR_SESSION'];
    if (process.env['HERDR_CONFIG_PATH']) {
        env['HERDR_CONFIG_PATH'] = process.env['HERDR_CONFIG_PATH'];
    }
    
    let options: any = { env };
    let cb = callback;

    if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback;
    } else if (optionsOrCallback) {
        options = { ...optionsOrCallback, env: { ...(optionsOrCallback.env || {}), ...env } };
    }

    if (cb) {
        cp.execFile('herdr', args, options, async (error: any, stdout: string, stderr: string) => {
            if (error && !options._isRetry && (
                (error.message && error.message.includes('server_not_running')) ||
                (stderr && stderr.includes('server_not_running')) ||
                (stdout && stdout.includes('server_not_running'))
            )) {
                // Auto-start server and retry
                let sessionName = 'default';
                if (args[0] === '--session' && args[1]) {
                    sessionName = args[1];
                }
                const started = await ensureSessionServerRunning(sessionName);
                if (started) {
                    execHerdr(args, { ...options, _isRetry: true }, cb);
                    return;
                }
            }
            cb(error, stdout, stderr);
        });
    } else {
        cp.execFile('herdr', args, options);
    }
}


// -----------------------------------------------------------------------------
// Utility: Run Git CLI commands safely with arguments array
// -----------------------------------------------------------------------------
export async function runGitCmd(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd }, (error: any, stdout: any, stderr: any) => {
            if (error) {
                // Check if git is missing
                if (error.code === 127 || error.code === 'ENOENT' || (error.message && error.message.includes('not found'))) {
                    reject(new Error('Git CLI is not installed or not in PATH. Please install Git to use this feature.'));
                } else if (args[0] === 'diff' && (error.code === 1 || error.code === undefined)) {
                    // Git diff can return exit code 1 if differences exist
                    resolve(stdout || '');
                } else {
                    const errMsg = (stderr && stderr.trim()) || error.message || 'Git command failed';
                    reject(new Error(errMsg));
                }
                return;
            }
            resolve(stdout || '');
        });
    });
}

/**
 * Checks if a CLI command / binary is available on the system PATH.
 * If args are provided, executes the command with args and checks for exit code 0.
 */
export async function isCommandAvailable(binary: string, args?: string[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        if (!binary) {
            resolve(false);
            return;
        }

        if (args && args.length > 0) {
            cp.execFile(binary, args, { timeout: 2000 }, (err) => {
                resolve(!err);
            });
            return;
        }

        const isWin = process.platform === 'win32';
        const checkTool = isWin ? 'where' : 'which';
        cp.execFile(checkTool, [binary], { timeout: 1500 }, (err) => {
            resolve(!err);
        });
    });
}
