/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as l10n from '@vscode/l10n';

function resolveVscodeModule(vscodeModule?: any): any {
    if (vscodeModule) {
        return vscodeModule;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('vscode');
    } catch {
        return undefined;
    }
}

/**
 * Returns true unless VS Code explicitly reports the current workspace as untrusted (`isTrusted === false`).
 */
export function isWorkspaceTrusted(vscodeModule?: any): boolean {
    const vscode = resolveVscodeModule(vscodeModule);
    if (!vscode || !vscode.workspace) {
        return true;
    }
    return vscode.workspace.isTrusted !== false;
}

/**
 * Guards user-initiated actions that invoke external CLIs, spawn daemons/agents, or mutate Git state.
 * In Restricted Mode, prompts via `vscode.workspace.requestWorkspaceTrust()` when available.
 */
export async function ensureWorkspaceTrustedForAction(
    vscodeModule?: any,
    customMessage?: string
): Promise<boolean> {
    const vscode = resolveVscodeModule(vscodeModule);
    if (!vscode || !vscode.workspace || vscode.workspace.isTrusted !== false) {
        return true;
    }

    const message = customMessage || l10n.t(
        'Workspace Trust is required to run Herdr agents, external CLIs, or Git write operations in this workspace.'
    );

    if (typeof vscode.workspace.requestWorkspaceTrust === 'function') {
        try {
            const granted = await vscode.workspace.requestWorkspaceTrust({ message });
            return Boolean(granted || vscode.workspace.isTrusted === true);
        } catch {
            return vscode.workspace.isTrusted === true;
        }
    }

    if (typeof vscode.window?.showWarningMessage === 'function') {
        await vscode.window.showWarningMessage(
            l10n.t('This action is disabled in Restricted Mode. Trust the workspace to continue.')
        );
    }
    return false;
}
