/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as path from 'path';

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

export interface MockTreeView {
    badge?: { value: number; tooltip: string };
    visible: boolean;
    selection: any[];
    onDidChangeSelection: any;
    onDidChangeVisibility: any;
    dispose(): void;
}

export interface MockVscodeState {
    lastWarningMessage?: { message: string; items: string[] };
    lastInformationMessage?: { message: string; items: string[] };
    warningMessageResponse?: string;
    informationMessageResponse?: string;
    inputBoxResponse?: string;
    statusBarItems: MockStatusBarItem[];
    treeViews: Map<string, MockTreeView>;
    configurations: Map<string, any>;
    executedCommands: { command: string; args: any[] }[];
}

export const mockState: MockVscodeState = {
    statusBarItems: [],
    treeViews: new Map(),
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
    mockState.treeViews = new Map();
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
    constructor(public readonly id: string, public readonly color?: any) {}
}

export class MockThemeColor {
    constructor(public readonly id: string) {}
}

export class MockTreeItem {
    public id?: string;
    public description?: string;
    public tooltip?: any;
    public iconPath?: any;
    public command?: any;
    constructor(public label: string, public collapsibleState?: any) {}
}

export class MockDataTransferItem {
    constructor(public readonly value: any) {}
    async asString(): Promise<string> {
        return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
    }
}

export class MockDataTransfer {
    private items = new Map<string, any>();
    get(mimeType: string): any {
        return this.items.get(mimeType);
    }
    set(mimeType: string, item: any): void {
        this.items.set(mimeType, item);
    }
    forEach(callback: (item: any, mimeType: string) => void): void {
        this.items.forEach(callback);
    }
}

export class MockPosition {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class MockRange {
    public readonly start: MockPosition;
    public readonly end: MockPosition;

    constructor(
        startLineOrPos: number | MockPosition,
        startCharacterOrEndPos: number | MockPosition,
        endLine?: number,
        endCharacter?: number
    ) {
        if (typeof startLineOrPos === 'object' && typeof startCharacterOrEndPos === 'object') {
            this.start = startLineOrPos;
            this.end = startCharacterOrEndPos;
        } else {
            const sLine = typeof startLineOrPos === 'number' ? startLineOrPos : 0;
            const sChar = typeof startCharacterOrEndPos === 'number' ? startCharacterOrEndPos : 0;
            const eLine = endLine !== undefined ? endLine : sLine;
            const eChar = endCharacter !== undefined ? endCharacter : sChar;
            this.start = new MockPosition(sLine, sChar);
            this.end = new MockPosition(eLine, eChar);
        }
    }

    get startLine(): number { return this.start.line; }
    get startCharacter(): number { return this.start.character; }
    get endLine(): number { return this.end.line; }
    get endCharacter(): number { return this.end.character; }

    contains(positionOrRange: any): boolean {
        const line = positionOrRange.line !== undefined ? positionOrRange.line : positionOrRange.start?.line;
        return line >= this.start.line && line <= this.end.line;
    }
}

export class MockCodeAction {
    public command?: any;
    public isPreferred?: boolean;
    public diagnostics?: any[];
    constructor(public title: string, public kind?: any) {}
}

export class MockCodeLens {
    constructor(public range: MockRange, public command?: any) {}
}

export class MockDiagnostic {
    public code?: string | number;
    public source?: string;
    constructor(public range: MockRange, public message: string, public severity: number = 0) {}
}

export const MockDiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
};

export const MockCodeActionKind = {
    QuickFix: { value: 'quickfix' },
    Refactor: { value: 'refactor' },
    Source: { value: 'source' }
};

export class MockEventEmitter<T> {
    private listeners: ((e: T) => any)[] = [];
    public event = (listener: (e: T) => any) => {
        this.listeners.push(listener);
        return { dispose: () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        }};
    };
    public fire(data: T): void {
        this.listeners.forEach(l => l(data));
    }
    public dispose(): void {
        this.listeners = [];
    }
}

import * as l10n from '@vscode/l10n';

export const mockVscode = {
    l10n: {
        t: (message: any, ...args: any[]): string => {
            return (l10n.t as any)(message, ...args);
        },
        uri: undefined,
        bundle: undefined
    },
    StatusBarAlignment: {
        Left: 1,
        Right: 2
    },
    ThemeIcon: MockThemeIcon,
    ThemeColor: MockThemeColor,
    MarkdownString: MockMarkdownString,
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    },
    Position: MockPosition,
    Range: MockRange,
    CodeAction: MockCodeAction,
    CodeLens: MockCodeLens,
    Diagnostic: MockDiagnostic,
    DiagnosticSeverity: MockDiagnosticSeverity,
    CodeActionKind: MockCodeActionKind,
    EventEmitter: MockEventEmitter,
    languages: {
        registerCodeActionsProvider: (selector: any, provider: any, metadata?: any) => ({ dispose: () => {} }),
        registerCodeLensProvider: (selector: any, provider: any) => ({ dispose: () => {} }),
        getDiagnostics: (uri?: any): any[] => []
    },
    comments: {
        createCommentController: (id: string, label: string) => {
            return {
                id,
                label,
                commentingRangeProvider: undefined,
                createCommentThread: (uri: any, range: any, comments: any[]) => {
                    return {
                        uri,
                        range,
                        comments,
                        dispose: () => {}
                    };
                },
                dispose: () => {}
            };
        }
    },
    DataTransfer: MockDataTransfer,
    DataTransferItem: MockDataTransferItem,
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
        },
        createTreeView: (viewId: string, _options?: any): MockTreeView => {
            const view: MockTreeView = {
                badge: undefined,
                visible: true,
                selection: [],
                onDidChangeSelection: () => ({ dispose: () => {} }),
                onDidChangeVisibility: () => ({ dispose: () => {} }),
                dispose: () => {}
            };
            mockState.treeViews.set(viewId, view);
            return view;
        }
    },
    workspace: {
        asRelativePath: (pathOrUri: any, _includeWorkspaceFolder?: boolean): string => {
            const p = typeof pathOrUri === 'string' ? pathOrUri : (pathOrUri?.fsPath || pathOrUri?.path || '');
            return path.basename(p);
        },
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
