/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */

export interface MockStatusBarItem {
    id: string;
    alignment: any;
    priority: number;
    text: string;
    tooltip: any;
    command: string | undefined;
    name: string | undefined;
    backgroundColor: any;
    visible: boolean;
    show(): void;
    hide(): void;
    dispose(): void;
}

export interface MockVscodeState {
    lastWarningMessage?: { message: string; items: string[] };
    lastInformationMessage?: { message: string; items: string[] };
    warningMessageResponse?: string;
    informationMessageResponse?: string;
    inputBoxResponse?: string;
    statusBarItems: MockStatusBarItem[];
    configurations: Map<string, any>;
    executedCommands: { command: string; args: any[] }[];
}

export const mockState: MockVscodeState = {
    statusBarItems: [],
    configurations: new Map(),
    executedCommands: []
};

export function resetMockState(): void {
    mockState.lastWarningMessage = undefined;
    mockState.lastInformationMessage = undefined;
    mockState.warningMessageResponse = undefined;
    mockState.informationMessageResponse = undefined;
    mockState.inputBoxResponse = undefined;
    mockState.statusBarItems = [];
    mockState.configurations.clear();
    mockState.executedCommands = [];
}

export class MockMarkdownString {
    public value: string = '';
    public isTrusted: boolean = false;
    constructor(value: string = '') {
        this.value = value;
    }
    appendMarkdown(str: string): this {
        this.value += str;
        return this;
    }
}

export class MockThemeIcon {
    constructor(public readonly id: string) {}
}

export class MockThemeColor {
    constructor(public readonly id: string) {}
}

export const mockVscode = {
    StatusBarAlignment: {
        Left: 1,
        Right: 2
    },
    ThemeIcon: MockThemeIcon,
    ThemeColor: MockThemeColor,
    MarkdownString: MockMarkdownString,
    window: {
        createStatusBarItem: (idOrAlignment?: any, alignmentOrPriority?: any, priority?: any): MockStatusBarItem => {
            const item: MockStatusBarItem = {
                id: typeof idOrAlignment === 'string' ? idOrAlignment : 'default',
                alignment: typeof idOrAlignment === 'number' ? idOrAlignment : alignmentOrPriority,
                priority: priority || 0,
                text: '',
                tooltip: undefined,
                command: undefined,
                name: undefined,
                backgroundColor: undefined,
                visible: false,
                show() { this.visible = true; },
                hide() { this.visible = false; },
                dispose() { this.visible = false; }
            };
            mockState.statusBarItems.push(item);
            return item;
        },
        showWarningMessage: async (message: string, ...items: any[]): Promise<string | undefined> => {
            mockState.lastWarningMessage = { message, items };
            return mockState.warningMessageResponse;
        },
        showInformationMessage: async (message: string, ...items: any[]): Promise<string | undefined> => {
            mockState.lastInformationMessage = { message, items };
            return mockState.informationMessageResponse;
        },
        showInputBox: async (options?: any): Promise<string | undefined> => {
            return mockState.inputBoxResponse;
        },
        showQuickPick: async (items: any[], options?: any): Promise<any> => {
            return Array.isArray(items) && items.length > 0 ? items[0] : undefined;
        },
        createQuickPick: () => {
            return {
                title: '',
                placeholder: '',
                items: [],
                selectedItems: [],
                onDidTriggerItemButton: (cb: any) => {},
                onDidAccept: (cb: any) => {},
                show: () => {},
                hide: () => {},
                dispose: () => {}
            };
        }
    },
    workspace: {
        getConfiguration: (section?: string) => {
            return {
                get: <T>(key: string, defaultValue?: T): T => {
                    const fullKey = section ? `${section}.${key}` : key;
                    if (mockState.configurations.has(fullKey)) {
                        return mockState.configurations.get(fullKey);
                    }
                    if (mockState.configurations.has(key)) {
                        return mockState.configurations.get(key);
                    }
                    return defaultValue as T;
                }
            };
        }
    },
    commands: {
        executeCommand: async (command: string, ...args: any[]): Promise<any> => {
            mockState.executedCommands.push({ command, args });
            return undefined;
        }
    }
};

// Install mock into require cache for 'vscode'
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
    if (id === 'vscode') {
        return mockVscode;
    }
    return originalRequire.apply(this, arguments);
};
