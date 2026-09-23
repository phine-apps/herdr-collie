/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as cp from 'child_process';
import * as net from 'net';
import * as path from 'path';
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

/**
 * Recursively checks if a process with name `targetProcessName` is running
 * as `rootPid` itself or as a child/descendant of `rootPid`.
 */
export async function isProcessDescendantRunning(rootPid: number, targetProcessName: string): Promise<boolean> {
    if (!rootPid || rootPid <= 0 || !targetProcessName || typeof rootPid !== 'number') {
        return false;
    }

    // Sanitize targetProcessName to prevent command or script injection
    const cleanProcessName = targetProcessName.trim();
    if (!cleanProcessName || !/^[a-zA-Z0-9_.-]+$/.test(cleanProcessName)) {
        return false;
    }

    return new Promise<boolean>((resolve) => {
        if (process.platform === 'win32') {
            const safeTarget = cleanProcessName.toLowerCase().replace(/\.exe$/, '');
            const psScript = `
$target = '${safeTarget}';
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name;
$childrenMap = @{};
$names = @{};
foreach ($p in $procs) {
    $ppid = $p.ParentProcessId;
    if (-not $childrenMap.ContainsKey($ppid)) { $childrenMap[$ppid] = @(); }
    $childrenMap[$ppid] += $p.ProcessId;
    $names[$p.ProcessId] = $p.Name;
}
$queue = New-Object System.Collections.Generic.Queue[int];
$queue.Enqueue(${rootPid});
$visited = New-Object System.Collections.Generic.HashSet[int];
$found = $false;
while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue();
    if ($visited.Contains($cur)) { continue; }
    [void]$visited.Add($cur);
    $n = $names[$cur];
    if ($n) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($n).ToLower();
        if ($base -eq $target) { $found = $true; break; }
    }
    if ($childrenMap.ContainsKey($cur)) {
        foreach ($c in $childrenMap[$cur]) { $queue.Enqueue($c); }
    }
}
if ($found) { Write-Output '1'; }
            `.trim();

            cp.execFile('powershell', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                psScript
            ], { timeout: 3000 }, (err, stdout) => {
                if (!err && stdout && stdout.trim() === '1') {
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
            return;
        }

        // Unix (macOS / Linux): ps -A -o ppid,pid,comm
        cp.execFile('ps', ['-A', '-o', 'ppid,pid,comm'], { timeout: 2000 }, (err, stdout) => {
            if (err || !stdout) {
                resolve(false);
                return;
            }

            const childrenMap = new Map<number, number[]>();
            const commMap = new Map<number, string>();

            const lines = stdout.split('\n');
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
                if (match) {
                    const ppid = parseInt(match[1], 10);
                    const pid = parseInt(match[2], 10);
                    const comm = match[3].trim();
                    commMap.set(pid, comm);
                    if (!childrenMap.has(ppid)) {
                        childrenMap.set(ppid, []);
                    }
                    childrenMap.get(ppid)!.push(pid);
                }
            }

            // Traverse rootPid and all descendants
            const queue = [rootPid, ...(childrenMap.get(rootPid) || [])];
            const visited = new Set<number>();

            while (queue.length > 0) {
                const curPid = queue.shift()!;
                if (visited.has(curPid)) continue;
                visited.add(curPid);

                const comm = commMap.get(curPid) || '';
                // Handle both full path (which may contain spaces) and tokenized arguments
                const fullBasename = path.basename(comm);
                const firstBasename = path.basename(comm.split(' ')[0]);
                if (
                    fullBasename === cleanProcessName || 
                    fullBasename === `${cleanProcessName}.exe` ||
                    firstBasename === cleanProcessName || 
                    firstBasename === `${cleanProcessName}.exe`
                ) {
                    resolve(true);
                    return;
                }

                const nextChildren = childrenMap.get(curPid);
                if (nextChildren) {
                    queue.push(...nextChildren);
                }
            }

            resolve(false);
        });
    });
}


