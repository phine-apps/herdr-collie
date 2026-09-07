/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as toml from 'smol-toml';

let originalConfigPathCache: string | null = null;
let watcherInstance: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/**
 * Returns the path to the user's original herdr config.toml.
 */
export function getOriginalConfigPath(): string {
    if (originalConfigPathCache) {
        return originalConfigPathCache;
    }
    const envPath = process.env['HERDR_ORIGINAL_CONFIG_PATH'] || process.env['HERDR_CONFIG_PATH'];
    if (envPath && !envPath.includes('herdr_config_embedded.toml')) {
        originalConfigPathCache = envPath;
    } else {
        originalConfigPathCache = path.join(os.homedir(), '.config', 'herdr', 'config.toml');
    }
    return originalConfigPathCache;
}

/**
 * Reset cached original config path (mainly for unit testing).
 */
export function setOriginalConfigPathForTesting(customPath: string | null) {
    originalConfigPathCache = customPath;
}

/**
 * Generates TOML content with sidebar hidden settings merged.
 */
export function generateEmbeddedConfigContent(originalContent: string, hideSidebar: boolean = true): string {
    if (!hideSidebar) {
        return originalContent;
    }

    try {
        let parsed: any = {};
        if (originalContent.trim().length > 0) {
            parsed = toml.parse(originalContent);
        }

        const uiSection = (parsed.ui && typeof parsed.ui === 'object') ? parsed.ui : {};
        parsed.ui = {
            ...uiSection,
            sidebar_width: 0,
            sidebar_min_width: 0,
            sidebar_start_collapsed: true,
            sidebar_collapsed_mode: 'hidden'
        };

        return toml.stringify(parsed);
    } catch (e) {
        // Fallback in case of parse error: append/return minimal UI config
        return originalContent + '\n\n[ui]\nsidebar_width = 0\nsidebar_min_width = 0\nsidebar_start_collapsed = true\nsidebar_collapsed_mode = "hidden"\n';
    }
}





export interface ExtensionContextLike {
    globalStorageUri: { fsPath: string };
    environmentVariableCollection?: {
        replace(variable: string, value: string): void;
        delete(variable: string): void;
    };
    subscriptions: { dispose(): any }[];
}

/**
 * Synchronizes the embedded herdr config and sets the HERDR_CONFIG_PATH environment variable.
 */
export function syncHerdrConfig(
    context: ExtensionContextLike,
    hideSidebar: boolean = true
): string | undefined {
    if (!hideSidebar) {
        if (context.environmentVariableCollection) {
            context.environmentVariableCollection.delete('HERDR_CONFIG_PATH');
        }
        if (process.env['HERDR_CONFIG_PATH']?.includes('herdr_config_embedded.toml')) {
            delete process.env['HERDR_CONFIG_PATH'];
        }
        return undefined;
    }

    const origPath = getOriginalConfigPath();
    let originalContent = '';
    if (fs.existsSync(origPath)) {
        try {
            originalContent = fs.readFileSync(origPath, 'utf8');
        } catch (e) {
            console.error('[herdr-collie] Failed to read original config.toml:', e);
        }
    }

    const newContent = generateEmbeddedConfigContent(originalContent, true);
    const storageDir = context.globalStorageUri.fsPath;

    try {
        if (!fs.existsSync(storageDir)) {
            fs.mkdirSync(storageDir, { recursive: true });
        }
        const embeddedPath = path.join(storageDir, 'herdr_config_embedded.toml');
        fs.writeFileSync(embeddedPath, newContent, 'utf8');

        if (context.environmentVariableCollection) {
            context.environmentVariableCollection.replace('HERDR_CONFIG_PATH', embeddedPath);
        }
        process.env['HERDR_CONFIG_PATH'] = embeddedPath;

        // Notify running servers to reload config
        try {
            const { execHerdr } = require('./executors');
            execHerdr(['server', 'reload-config'], () => {});
            execHerdr(['--session', 'vscode', 'server', 'reload-config'], () => {});
        } catch (e) {}

        return embeddedPath;
    } catch (e) {

        console.error('[herdr-collie] Failed to write embedded config.toml:', e);
        return undefined;
    }
}

/**
 * Sets up file watching on the original config.toml and listens to configuration changes.
 */
export function setupConfigManager(
    context: any,
    vscodeModule?: any
): { dispose(): void } {
    let vscode = vscodeModule;
    if (!vscode) {
        try {
            vscode = require('vscode');
        } catch (e) {
            // In unit tests without vscode runtime
        }
    }

    const getHideSidebarSetting = () => {
        if (vscode && vscode.workspace) {
            const config = vscode.workspace.getConfiguration('herdr-collie');
            return config.get('hideHerdrSidebar', true);
        }
        return true;
    };

    // Initial sync
    syncHerdrConfig(context, getHideSidebarSetting());

    // Watch original config.toml
    const origPath = getOriginalConfigPath();
    const configDir = path.dirname(origPath);

    function handleFileChange() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            syncHerdrConfig(context, getHideSidebarSetting());
        }, 200);
    }

    try {
        if (fs.existsSync(configDir)) {
            watcherInstance = fs.watch(configDir, (eventType, filename) => {
                if (!filename || filename === path.basename(origPath)) {
                    handleFileChange();
                }
            });
        }
    } catch (e) {
        console.warn('[herdr-collie] Could not watch config directory:', e);
    }

    let configChangeSub: { dispose(): void } | null = null;
    if (vscode && vscode.workspace && vscode.workspace.onDidChangeConfiguration) {
        configChangeSub = vscode.workspace.onDidChangeConfiguration((e: any) => {
            if (e.affectsConfiguration('herdr-collie.hideHerdrSidebar')) {
                syncHerdrConfig(context, getHideSidebarSetting());
            }
        });
    }

    const disposable = {
        dispose: () => {
            if (watcherInstance) {
                try {
                    watcherInstance.close();
                } catch (e) {}
                watcherInstance = null;
            }
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            if (configChangeSub) {
                configChangeSub.dispose();
            }
        }
    };

    context.subscriptions.push(disposable);
    return disposable;
}
