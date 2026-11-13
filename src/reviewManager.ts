/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { runGitCmd } from './executors';
import { formatCodeFence } from './formatters';

function runGitWithEnv(args: string[], cwd: string, extraEnv: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(
            'git',
            args,
            { cwd, env: { ...process.env, ...extraEnv }, maxBuffer: 10 * 1024 * 1024 },
            (error: any, stdout: any, stderr: any) => {
                if (error) {
                    const msg = (stderr && String(stderr).trim()) || (stdout && String(stdout).trim()) || error.message || 'Git command failed';
                    reject(new Error(msg));
                    return;
                }
                resolve(stdout || '');
            }
        );
    });
}

export interface ReviewCommentItem {
    id: string;
    filePath: string;
    fileName: string;
    startLine: number; // 1-based
    endLine: number;   // 1-based
    codeSnippet?: string;
    commentText: string;
    author?: string;
    createdAt?: number;
}

export interface ReviewFormatOptions {
    agentName?: string;
    branchName?: string;
    customInstruction?: string;
    crystallizeRule?: boolean;
    targetRuleFile?: string;
}

/**
 * Detect language identifier for markdown code blocks based on file extension
 */
export function detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.ts': return 'typescript';
        case '.tsx': return 'tsx';
        case '.js':
        case '.mjs':
        case '.cjs': return 'javascript';
        case '.jsx': return 'jsx';
        case '.py': return 'python';
        case '.rs': return 'rust';
        case '.go': return 'go';
        case '.json': return 'json';
        case '.md': return 'markdown';
        case '.yaml':
        case '.yml': return 'yaml';
        case '.toml': return 'toml';
        case '.html':
        case '.htm': return 'html';
        case '.css': return 'css';
        case '.scss':
        case '.sass': return 'scss';
        case '.sh':
        case '.bash':
        case '.zsh': return 'bash';
        case '.sql': return 'sql';
        case '.c':
        case '.h': return 'c';
        case '.cpp':
        case '.cc':
        case '.hpp': return 'cpp';
        case '.java': return 'java';
        case '.rb': return 'ruby';
        case '.php': return 'php';
        case '.swift': return 'swift';
        case '.kt': return 'kotlin';
        default: return 'text';
    }
}

/**
 * Extract code snippet from multi-line text by 1-based line bounds
 */
export function extractSnippet(content: string, startLine: number, endLine: number, maxLines: number = 30): string {
    if (!content) return '';
    const lines = content.split(/\r?\n/);
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(lines.length, endLine);
    if (startIdx >= lines.length || startIdx >= endIdx) return '';

    const selectedLines = lines.slice(startIdx, endIdx);
    if (selectedLines.length > maxLines) {
        const half = Math.floor(maxLines / 2);
        return [
            ...selectedLines.slice(0, half),
            `... (${selectedLines.length - maxLines} lines truncated) ...`,
            ...selectedLines.slice(selectedLines.length - half)
        ].join('\n');
    }
    return selectedLines.join('\n');
}

/**
 * Safely extracts snippet from disk if file exists
 */
export function extractSnippetFromFile(filePath: string, startLine: number, endLine: number): string | undefined {
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return extractSnippet(content, startLine, endLine);
        }
    } catch {
        // Silently ignore file read errors
    }
    return undefined;
}

/**
 * Formats a list of review comments into a structured markdown prompt for AI agents
 */
export function formatReviewFeedback(
    comments: ReviewCommentItem[],
    options: ReviewFormatOptions = {}
): string {
    if (!comments || comments.length === 0) {
        return '';
    }

    // Group comments by file
    const commentsByFile = new Map<string, ReviewCommentItem[]>();
    for (const c of comments) {
        const fileKey = c.filePath || c.fileName;
        if (!commentsByFile.has(fileKey)) {
            commentsByFile.set(fileKey, []);
        }
        commentsByFile.get(fileKey)!.push(c);
    }

    const lines: string[] = [];
    const agentHeader = options.agentName ? ` to ${options.agentName}` : '';
    lines.push(`## 🔍 Code Review Feedback${agentHeader}`);
    lines.push('');
    if (options.branchName) {
        lines.push(`**Branch / Worktree:** \`${options.branchName}\``);
        lines.push('');
    }
    lines.push('Please review and address the following inline review comments on your recent code changes:');
    lines.push('');

    for (const [filePath, fileComments] of commentsByFile.entries()) {
        lines.push(`### 📄 \`${filePath}\``);
        lines.push('');

        // Sort comments by startLine
        const sorted = [...fileComments].sort((a, b) => a.startLine - b.startLine);

        for (const comment of sorted) {
            const lineDesc = comment.startLine === comment.endLine
                ? `Line ${comment.startLine}`
                : `Lines ${comment.startLine}-${comment.endLine}`;

            lines.push(`#### 💬 ${lineDesc}`);

            if (comment.codeSnippet && comment.codeSnippet.trim()) {
                const lang = detectLanguage(filePath);
                lines.push(formatCodeFence(comment.codeSnippet, lang));
            }

            // Format user's feedback as blockquote
            const feedbackText = comment.commentText.trim();
            const quotedFeedback = feedbackText.split('\n').map(l => `> ${l}`).join('\n');
            lines.push(quotedFeedback);
            lines.push('');
        }
    }

    if (options.customInstruction && options.customInstruction.trim()) {
        lines.push(`**Additional Instructions:**`);
        lines.push(options.customInstruction.trim());
        lines.push('');
    }

    if (options.crystallizeRule) {
        const ruleFile = (options.targetRuleFile && options.targetRuleFile.trim()) ? options.targetRuleFile.trim() : 'AGENTS.md';
        lines.push(`### 🔄 Outer-Loop Rule Crystallization (\`${ruleFile}\`)`);
        lines.push(`In addition to fixing the code issues above, please distill any generalizable coding conventions, architectural constraints, or anti-patterns from this review feedback and append a concise rule to \`${ruleFile}\` to prevent recurrence.`);
        lines.push('');
    }

    lines.push('---');
    lines.push('Please apply the requested fixes, ensure consistency, and verify with tests.');

    return lines.join('\n');
}

/**
 * Review Controller managing VS Code Comments API integration and review sessions
 */
export class HerdrReviewController implements vscode.Disposable {
    private commentController?: vscode.CommentController;
    private threads: Map<string, vscode.CommentThread> = new Map();
    private pendingComments: Map<string, ReviewCommentItem> = new Map();
    private _onDidUpdateComments?: vscode.EventEmitter<ReviewCommentItem[]>;
    public readonly onDidUpdateComments?: vscode.Event<ReviewCommentItem[]>;

    constructor() {
        if (vscode && vscode.comments) {
            this._onDidUpdateComments = new vscode.EventEmitter<ReviewCommentItem[]>();
            this.onDidUpdateComments = this._onDidUpdateComments.event;
            this.initCommentController();
        }
    }

    private initCommentController(): void {
        if (!vscode || !vscode.comments) return;

        this.commentController = vscode.comments.createCommentController(
            'herdr-collie.review',
            'Herdr Agent Review'
        );

        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument) => {
                const lineCount = document.lineCount;
                return [new vscode.Range(0, 0, Math.max(0, lineCount - 1), 0)];
            }
        };
    }

    /**
     * Add or register a comment item into the review session
     */
    public addComment(comment: ReviewCommentItem): void {
        this.pendingComments.set(comment.id, comment);
        this._onDidUpdateComments?.fire(this.getPendingComments());
    }

    /**
     * Creates a comment item from editor selection/range and creates a visual comment thread if supported
     */
    public addCommentFromEditor(
        uri: vscode.Uri,
        startLine: number,
        endLine: number,
        commentText: string,
        codeSnippet?: string
    ): ReviewCommentItem {
        const id = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        let relPath = uri.fsPath;
        if (vscode && vscode.workspace && typeof vscode.workspace.asRelativePath === 'function') {
            relPath = vscode.workspace.asRelativePath(uri);
        }

        const commentItem: ReviewCommentItem = {
            id,
            filePath: relPath,
            fileName: path.basename(uri.fsPath),
            startLine,
            endLine,
            codeSnippet,
            commentText,
            createdAt: Date.now()
        };

        this.addComment(commentItem);

        // Also create native VS Code comment thread if API is available
        if (this.commentController && vscode && vscode.Range) {
            try {
                const range = new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0);
                const thread = this.commentController.createCommentThread(uri, range, [{
                    author: { name: 'Herdr Reviewer' },
                    body: vscode.MarkdownString ? new vscode.MarkdownString(commentText) : (commentText as any),
                    mode: vscode.CommentMode ? vscode.CommentMode.Preview : 1
                }]);
                this.threads.set(id, thread);
            } catch (err) {
                console.error('[herdr-collie] Error creating comment thread:', err);
            }
        }

        return commentItem;
    }

    /**
     * Remove comment by ID and dispose associated thread
     */
    public removeComment(commentId: string): void {
        const thread = this.threads.get(commentId);
        if (thread) {
            thread.dispose();
            this.threads.delete(commentId);
        }
        if (this.pendingComments.delete(commentId)) {
            this._onDidUpdateComments?.fire(this.getPendingComments());
        }
    }

    /**
     * Get all pending review comments
     */
    public getPendingComments(): ReviewCommentItem[] {
        return Array.from(this.pendingComments.values());
    }

    /**
     * Number of pending comments
     */
    public get commentCount(): number {
        return this.pendingComments.size;
    }

    /**
     * Clear all comments and dispose threads
     */
    public clearAll(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
        this.pendingComments.clear();
        this._onDidUpdateComments?.fire([]);
    }

    /**
     * Format current pending comments into prompt
     */
    public formatPrompt(options?: ReviewFormatOptions): string {
        return formatReviewFeedback(this.getPendingComments(), options);
    }

    /**
     * All-or-Nothing safe delivery of pending review comments.
     * Clears the pending comment queue ONLY if `deliverFn` resolves to `true`.
     * If `deliverFn` returns `false` (e.g. user cancelled target selection) or throws an error,
     * all pending comments and inline threads are preserved for retry.
     */
    public async submitSafely(
        deliverFn: (prompt: string) => Promise<boolean>,
        options?: ReviewFormatOptions
    ): Promise<boolean> {
        if (this.commentCount === 0) {
            return false;
        }

        const prompt = this.formatPrompt(options);
        if (!prompt) {
            return false;
        }

        try {
            const delivered = await deliverFn(prompt);
            if (delivered) {
                this.clearAll();
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    public dispose(): void {
        this.clearAll();
        this.commentController?.dispose();
        this._onDidUpdateComments?.dispose();
    }
}

export interface ChangedFileInfo {
    filePath: string;
    originalFilePath?: string;
    fileName: string;
    status: 'M' | 'A' | 'D' | 'R' | '??';
    statusLabel: string;
    fullPath: string;
}

function unquoteGitPath(raw: string): string {
    const trimmed = raw.trim();
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) {
        return trimmed;
    }

    const inner = trimmed.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '\\' && i + 1 < inner.length) {
            const next = inner[i + 1];
            if (/^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
                bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
                i += 3;
                continue;
            }
            const escapeMap: Record<string, number> = {
                'a': 0x07,
                'b': 0x08,
                't': 0x09,
                'n': 0x0a,
                'v': 0x0b,
                'f': 0x0c,
                'r': 0x0d,
                '"': 0x22,
                '\\': 0x5c
            };
            if (next in escapeMap) {
                bytes.push(escapeMap[next]);
                i += 1;
                continue;
            }
        }
        const utf8 = Buffer.from(ch, 'utf8');
        for (const b of utf8) {
            bytes.push(b);
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

/**
 * Parses git status --porcelain output into structured ChangedFileInfo list
 */
export function parseGitStatusPorcelain(output: string, repoRoot: string): ChangedFileInfo[] {
    if (!output || !output.trim()) return [];

    const lines = output.split(/\r?\n/).filter(Boolean);
    const results: ChangedFileInfo[] = [];

    for (const line of lines) {
        if (line.length < 3) continue;
        const statusCode = line.substring(0, 2);
        let rawPath = line.substring(3).trim();
        let originalFilePath: string | undefined;

        // Handle renames (e.g. "R  orig.ts -> dest.ts")
        if (rawPath.includes(' -> ')) {
            const arrowIdx = rawPath.indexOf(' -> ');
            originalFilePath = unquoteGitPath(rawPath.slice(0, arrowIdx));
            rawPath = unquoteGitPath(rawPath.slice(arrowIdx + 4));
        } else {
            rawPath = unquoteGitPath(rawPath);
        }

        let status: 'M' | 'A' | 'D' | 'R' | '??' = 'M';
        let statusLabel = 'Modified';

        if (statusCode.includes('?')) {
            status = '??';
            statusLabel = 'Untracked';
        } else if (statusCode.includes('A')) {
            status = 'A';
            statusLabel = 'Added';
        } else if (statusCode.includes('D')) {
            status = 'D';
            statusLabel = 'Deleted';
        } else if (statusCode.includes('R')) {
            status = 'R';
            statusLabel = 'Renamed';
        } else {
            status = 'M';
            statusLabel = 'Modified';
        }

        results.push({
            filePath: rawPath,
            ...(originalFilePath ? { originalFilePath } : {}),
            fileName: path.basename(rawPath),
            status,
            statusLabel,
            fullPath: path.resolve(repoRoot, rawPath)
        });
    }

    return results;
}

/**
 * Gets list of changed files for a git repository
 */
export async function getRepoChangedFiles(repoRoot: string): Promise<ChangedFileInfo[]> {
    try {
        const stdout = await runGitCmd(['status', '--porcelain', '-uall'], repoRoot);
        return parseGitStatusPorcelain(stdout, repoRoot);
    } catch {
        return [];
    }
}

/**
 * Resolves the temporary directory used for caching original HEAD files
 */
export function getDiffCacheDir(): string {
    return path.join(os.tmpdir(), 'herdr-collie-diff-cache');
}

/**
 * Cleans up temporary diff cache files older than maxAgeMs (default: 1 hour)
 */
export function cleanDiffCache(maxAgeMs = 3600000): void {
    try {
        const cacheDir = getDiffCacheDir();
        if (!fs.existsSync(cacheDir)) return;
        const now = Date.now();
        const entries = fs.readdirSync(cacheDir);
        for (const entry of entries) {
            const fullPath = path.join(cacheDir, entry);
            try {
                const stats = fs.statSync(fullPath);
                if (maxAgeMs === 0 || now - stats.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(fullPath);
                }
            } catch {}
        }
    } catch {}
}

/**
 * Prepares the base version (HEAD or specified checkpoint ref) of a file in a temporary location for VS Code diffing
 */
export async function prepareOriginalFileForDiff(
    repoRoot: string,
    filePath: string,
    baseRef: string = 'HEAD'
): Promise<string> {
    cleanDiffCache(); // Purge stale temp files periodically

    const cacheDir = getDiffCacheDir();
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const safeFileName = `${Date.now()}_${path.basename(filePath)}`;
    const tempFilePath = path.join(cacheDir, safeFileName);

    // Normalize Windows backslashes to POSIX slashes for Git CLI compatibility
    const posixPath = filePath.replace(/\\/g, '/');
    const safeRef = validateCheckpointRef(baseRef) ? baseRef.trim() : 'HEAD';

    try {
        const headContent = await runGitCmd(['show', `${safeRef}:${posixPath}`], repoRoot);
        fs.writeFileSync(tempFilePath, headContent, 'utf8');
    } catch {
        // If file is newly added or not in baseRef, write empty file
        fs.writeFileSync(tempFilePath, '', 'utf8');
    }

    return tempFilePath;
}

/**
 * Prepares an empty temporary file for deleted working-tree files in VS Code diff view.
 */
export function prepareEmptyFileForDiff(filePath: string): string {
    cleanDiffCache();
    const cacheDir = getDiffCacheDir();
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    const safeFileName = `${Date.now()}_deleted_${path.basename(filePath)}`;
    const tempFilePath = path.join(cacheDir, safeFileName);
    fs.writeFileSync(tempFilePath, '', 'utf8');
    return tempFilePath;
}

/**
 * Resolves left/right file paths and title for vscode.diff, handling renamed and deleted files.
 */
export async function resolveDiffTargets(
    change: ChangedFileInfo,
    repoRoot: string,
    baseRef: string = 'HEAD',
    baseLabel: string = 'HEAD'
): Promise<{ originalPath: string; workingPath: string; title: string }> {
    const originalGitPath = change.originalFilePath || change.filePath;
    const originalPath = await prepareOriginalFileForDiff(repoRoot, originalGitPath, baseRef);

    const isDeleted = change.status === 'D' || !fs.existsSync(change.fullPath);
    const workingPath = isDeleted ? prepareEmptyFileForDiff(change.filePath) : change.fullPath;
    const workingLabel = isDeleted ? 'Deleted' : 'Working Tree';
    const title = change.originalFilePath
        ? `${path.basename(change.originalFilePath)} → ${change.fileName} (${baseLabel} ↔ ${workingLabel})`
        : `${change.fileName} (${baseLabel} ↔ ${workingLabel})`;

    return { originalPath, workingPath, title };
}

export type ReviewViewMode = 'tree' | 'flat';

export class ReviewChangeTreeItem extends vscode.TreeItem {
    public readonly isFolder: boolean = false;

    constructor(
        public readonly change: ChangedFileInfo,
        public readonly repoRoot: string,
        viewMode: ReviewViewMode = 'flat',
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(change.fileName, collapsibleState);
        this.contextValue = 'changedFile';
        const dir = path.dirname(change.filePath);
        this.description = (viewMode === 'flat' && dir !== '.')
            ? `${dir} [${change.statusLabel}]`
            : `[${change.statusLabel}]`;
        this.tooltip = `${change.filePath} (${change.statusLabel})`;

        let iconName = 'diff-modified';
        if (change.status === 'A' || change.status === '??') {
            iconName = 'diff-added';
        } else if (change.status === 'D') {
            iconName = 'diff-removed';
        } else if (change.status === 'R') {
            iconName = 'diff-renamed';
        }

        this.iconPath = new vscode.ThemeIcon(iconName);

        this.command = {
            command: 'herdr-collie.openDiff',
            title: l10n.t('Open Diff'),
            arguments: [this]
        };
    }
}

export class ReviewFolderTreeItem extends ReviewChangeTreeItem {
    public override readonly isFolder: boolean = true;

    constructor(
        public readonly folderLabel: string,
        public readonly folderPath: string,
        repoRoot: string,
        public readonly children: ReviewChangeTreeItem[]
    ) {
        super(
            {
                filePath: folderPath,
                fileName: folderLabel,
                status: 'M',
                statusLabel: 'Folder',
                fullPath: path.resolve(repoRoot, folderPath)
            },
            repoRoot,
            'tree',
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.label = folderLabel;
        this.contextValue = 'changedFolder';
        this.description = '';
        this.tooltip = folderPath;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.command = undefined;
    }
}

interface InternalFolderTrieNode {
    segment: string;
    fullRelPath: string;
    subfolders: Map<string, InternalFolderTrieNode>;
    files: ChangedFileInfo[];
}

/**
 * Builds a hierarchical tree of ReviewFolderTreeItem and ReviewChangeTreeItem with VS Code-style compact folders
 */
export function buildReviewChangeTree(changes: ChangedFileInfo[], repoRoot: string): ReviewChangeTreeItem[] {
    if (!changes || changes.length === 0) return [];

    const root: InternalFolderTrieNode = {
        segment: '',
        fullRelPath: '',
        subfolders: new Map(),
        files: []
    };

    for (const change of changes) {
        const normalizedPath = change.filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const parts = normalizedPath.split('/').filter(Boolean);

        if (parts.length <= 1) {
            root.files.push(change);
            continue;
        }

        const dirParts = parts.slice(0, -1);
        let current = root;
        let accumulatedPath = '';

        for (const seg of dirParts) {
            accumulatedPath = accumulatedPath ? `${accumulatedPath}/${seg}` : seg;
            let next = current.subfolders.get(seg);
            if (!next) {
                next = {
                    segment: seg,
                    fullRelPath: accumulatedPath,
                    subfolders: new Map(),
                    files: []
                };
                current.subfolders.set(seg, next);
            }
            current = next;
        }

        current.files.push(change);
    }

    const convertFolderNode = (node: InternalFolderTrieNode): ReviewFolderTreeItem => {
        let label = node.segment;
        let current = node;

        // Compact single-child intermediate folders that contain no direct files
        while (current.files.length === 0 && current.subfolders.size === 1) {
            const onlyChild = Array.from(current.subfolders.values())[0];
            label = `${label}/${onlyChild.segment}`;
            current = onlyChild;
        }

        const childFolders = Array.from(current.subfolders.values())
            .map(convertFolderNode)
            .sort((a, b) => a.folderLabel.localeCompare(b.folderLabel));

        const childFiles = [...current.files]
            .sort((a, b) => a.fileName.localeCompare(b.fileName))
            .map(f => new ReviewChangeTreeItem(f, repoRoot, 'tree'));

        return new ReviewFolderTreeItem(label, current.fullRelPath, repoRoot, [...childFolders, ...childFiles]);
    };

    const topFolders = Array.from(root.subfolders.values())
        .map(convertFolderNode)
        .sort((a, b) => a.folderLabel.localeCompare(b.folderLabel));

    const topFiles = [...root.files]
        .sort((a, b) => a.fileName.localeCompare(b.fileName))
        .map(f => new ReviewChangeTreeItem(f, repoRoot, 'tree'));

    return [...topFolders, ...topFiles];
}

export class HerdrReviewChangesProvider implements vscode.TreeDataProvider<ReviewChangeTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<ReviewChangeTreeItem | undefined | null | void>;
    public readonly onDidChangeTreeData: vscode.Event<ReviewChangeTreeItem | undefined | null | void>;
    private viewMode: ReviewViewMode;
    private baseCheckpoint: ReviewCheckpoint | null = null;

    constructor(
        private readonly getRepoRoot: () => Promise<string | null>,
        initialViewMode?: ReviewViewMode
    ) {
        this._onDidChangeTreeData = new vscode.EventEmitter<ReviewChangeTreeItem | undefined | null | void>();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        if (initialViewMode) {
            this.viewMode = initialViewMode;
        } else {
            const config = vscode.workspace?.getConfiguration ? vscode.workspace.getConfiguration('herdr-collie') : undefined;
            const configured = config?.get<ReviewViewMode>('reviewChanges.viewMode', 'tree');
            this.viewMode = (configured === 'flat' || configured === 'tree') ? configured : 'tree';
        }
    }

    public getViewMode(): ReviewViewMode {
        return this.viewMode;
    }

    public setViewMode(mode: ReviewViewMode): void {
        this.viewMode = mode;
        this.refresh();
    }

    public toggleViewMode(): ReviewViewMode {
        this.viewMode = this.viewMode === 'tree' ? 'flat' : 'tree';
        this.refresh();
        return this.viewMode;
    }

    public getBaseCheckpoint(): ReviewCheckpoint | null {
        return this.baseCheckpoint;
    }

    public setBaseCheckpoint(checkpoint: ReviewCheckpoint | null): void {
        this.baseCheckpoint = checkpoint;
        this.refresh();
    }

    public getEffectiveBaseRef(): string {
        return (this.baseCheckpoint && validateCheckpointRef(this.baseCheckpoint.hash))
            ? this.baseCheckpoint.hash
            : 'HEAD';
    }

    public getEffectiveBaseLabel(): string {
        return this.baseCheckpoint ? this.baseCheckpoint.id : 'HEAD';
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: ReviewChangeTreeItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: ReviewChangeTreeItem): Promise<ReviewChangeTreeItem[]> {
        if (element) {
            if (element instanceof ReviewFolderTreeItem) {
                return element.children;
            }
            return [];
        }

        const repoRoot = await this.getRepoRoot();
        if (!repoRoot) return [];

        const changes = await getRepoChangedFiles(repoRoot);
        if (this.viewMode === 'flat') {
            return changes.map(c => new ReviewChangeTreeItem(c, repoRoot, 'flat'));
        }
        return buildReviewChangeTree(changes, repoRoot);
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

export interface ReviewCheckpoint {
    id: string;
    hash: string;
    timestamp: number;
    description: string;
}

/**
 * Validates checkpoint ref or commit hash to prevent flag/option injection and path traversal
 */
export function validateCheckpointRef(ref: string): boolean {
    if (!ref || typeof ref !== 'string') return false;
    const trimmed = ref.trim();
    if (!trimmed || trimmed.startsWith('-')) return false;
    return /^[a-zA-Z0-9_.\-\/]+$/.test(trimmed) && !trimmed.includes('..') && !trimmed.includes('//');
}

export interface RollbackOptions {
    cleanUntracked?: boolean;
    excludePatterns?: string[];
}

/**
 * Creates a git checkpoint before applying review feedback or running agent tasks.
 * Snapshots tracked changes plus pre-existing untracked files (excluding .env* and .vscode/*)
 * so rollback preserves untracked user files created prior to the checkpoint.
 */
export async function createReviewCheckpoint(repoRoot: string, label: string = 'pre-review'): Promise<ReviewCheckpoint | null> {
    try {
        const timestamp = Date.now();
        const safeLabel = (label || 'pre-review').replace(/[^a-zA-Z0-9_-]/g, '_');
        const checkpointId = `checkpoint_${timestamp}_${safeLabel}`;
        
        // Try creating a stash commit if dirty
        let commitHash = '';
        try {
            const stashOut = await runGitCmd(['stash', 'create', `Herdr Checkpoint: ${checkpointId}`], repoRoot);
            commitHash = stashOut.trim();
        } catch {
            commitHash = '';
        }

        // If working directory is clean or stash create returned empty, use current HEAD
        if (!commitHash) {
            commitHash = (await runGitCmd(['rev-parse', 'HEAD'], repoRoot)).trim();
        }

        if (!commitHash) {
            return null;
        }

        // Store as a ref under refs/herdr/checkpoints/
        await runGitCmd(['update-ref', `refs/herdr/checkpoints/${checkpointId}`, commitHash], repoRoot);

        // Snapshot pre-existing untracked files (excluding protected .env* and .vscode/*) into a companion tree ref
        try {
            const untrackedOut = await runGitCmd(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot);
            const untrackedFiles = untrackedOut
                .split('\0')
                .filter(Boolean)
                .filter(f => !path.basename(f).startsWith('.env') && !f.startsWith('.vscode/') && f !== '.vscode');

            if (untrackedFiles.length > 0) {
                const tempIndexPath = path.join(os.tmpdir(), `herdr-cp-idx-${timestamp}-${Math.random().toString(36).slice(2)}`);
                try {
                    const chunkSize = 50;
                    for (let i = 0; i < untrackedFiles.length; i += chunkSize) {
                        const chunk = untrackedFiles.slice(i, i + chunkSize);
                        await runGitWithEnv(['update-index', '--add', '--', ...chunk], repoRoot, { GIT_INDEX_FILE: tempIndexPath });
                    }
                    const treeHash = (await runGitWithEnv(['write-tree'], repoRoot, { GIT_INDEX_FILE: tempIndexPath })).trim();
                    if (treeHash) {
                        const untrackedCommitHash = (await runGitCmd(
                            ['commit-tree', treeHash, '-m', `Untracked snapshot for ${checkpointId}`],
                            repoRoot
                        )).trim();
                        if (untrackedCommitHash) {
                            await runGitCmd(['update-ref', `refs/herdr/checkpoint-untracked/${checkpointId}`, untrackedCommitHash], repoRoot);
                        }
                    }
                } finally {
                    try {
                        if (fs.existsSync(tempIndexPath)) {
                            fs.unlinkSync(tempIndexPath);
                        }
                    } catch {}
                }
            }
        } catch {
            // Non-fatal: tracked checkpoint was already recorded
        }

        return {
            id: checkpointId,
            hash: commitHash,
            timestamp,
            description: safeLabel
        };
    } catch {
        return null;
    }
}

function extractCheckpointTimestamp(cpId: string): number {
    const match = cpId.match(/^checkpoint_(\d+)_/);
    return match ? parseInt(match[1], 10) : 0;
}

async function resolveCheckpointUntrackedRef(repoRoot: string, checkpointHashOrRef: string): Promise<string | null> {
    try {
        const trimmedInput = checkpointHashOrRef.trim();
        const refsOut = await runGitCmd(['for-each-ref', '--format=%(refname)|%(objectname)', 'refs/herdr/checkpoints/'], repoRoot).catch(() => '');
        const entries = refsOut
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => {
                const [refName, objHash] = line.split('|');
                const cpId = refName.replace(/^refs\/herdr\/checkpoints\//, '');
                return { refName, objHash, cpId };
            });

        // 1. Exact ref/id match takes strict precedence and never falls back to another checkpoint sharing HEAD
        const exactMatch = entries.find(e => e.refName === trimmedInput || e.cpId === trimmedInput);
        if (exactMatch) {
            const untrackedRef = `refs/herdr/checkpoint-untracked/${exactMatch.cpId}`;
            const verified = await runGitCmd(['rev-parse', '--verify', untrackedRef], repoRoot).catch(() => '');
            return verified.trim() ? untrackedRef : null;
        }

        // 2. Hash match: pick the newest checkpoint sharing this commit hash so older HEAD checkpoints cannot resurrect stale files
        const resolvedHash = (await runGitCmd(['rev-parse', '--verify', trimmedInput], repoRoot)).trim();
        const hashMatches = entries
            .filter(e => e.objHash === resolvedHash)
            .sort((a, b) => {
                const tsDiff = extractCheckpointTimestamp(b.cpId) - extractCheckpointTimestamp(a.cpId);
                return tsDiff !== 0 ? tsDiff : b.cpId.localeCompare(a.cpId);
            });

        if (hashMatches.length > 0) {
            const untrackedRef = `refs/herdr/checkpoint-untracked/${hashMatches[0].cpId}`;
            const verified = await runGitCmd(['rev-parse', '--verify', untrackedRef], repoRoot).catch(() => '');
            if (verified.trim()) {
                return untrackedRef;
            }
        }
    } catch {
        // Ignore resolution errors
    }
    return null;
}

/**
 * Rolls back the repository state to a previously saved checkpoint
 */
export async function rollbackReviewCheckpoint(
    repoRoot: string, 
    checkpointHashOrRef: string,
    options: RollbackOptions = {}
): Promise<boolean> {
    if (!validateCheckpointRef(checkpointHashOrRef)) {
        return false;
    }

    try {
        const untrackedRef = await resolveCheckpointUntrackedRef(repoRoot, checkpointHashOrRef);

        await runGitCmd(['checkout', checkpointHashOrRef, '--', '.'], repoRoot);
        if (options.cleanUntracked !== false) {
            const cleanArgs = ['clean', '-fd', '-e', '.env*', '-e', '.vscode/*'];
            if (options.excludePatterns && options.excludePatterns.length > 0) {
                for (const pat of options.excludePatterns) {
                    cleanArgs.push('-e', pat);
                }
            }
            await runGitCmd(cleanArgs, repoRoot);
        }

        if (untrackedRef) {
            const tempIndexPath = path.join(os.tmpdir(), `herdr-restore-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            try {
                await runGitWithEnv(['read-tree', untrackedRef], repoRoot, { GIT_INDEX_FILE: tempIndexPath });
                await runGitWithEnv(['checkout-index', '-a', '-f'], repoRoot, { GIT_INDEX_FILE: tempIndexPath });
            } finally {
                try {
                    if (fs.existsSync(tempIndexPath)) {
                        fs.unlinkSync(tempIndexPath);
                    }
                } catch {}
            }
        }

        return true;
    } catch {
        return false;
    }
}

/**
 * Lists available review checkpoints for the repository
 */
export async function listReviewCheckpoints(repoRoot: string): Promise<ReviewCheckpoint[]> {
    try {
        const out = await runGitCmd([
            'for-each-ref',
            '--format=%(refname:short)|%(objectname)|%(committerdate:raw)',
            'refs/herdr/checkpoints/'
        ], repoRoot);

        if (!out || !out.trim()) return [];

        const lines = out.trim().split('\n');
        const checkpoints: ReviewCheckpoint[] = [];
        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length >= 3) {
                const refName = parts[0];
                const id = refName.replace(/^refs\/herdr\/checkpoints\//, '').replace(/^herdr\/checkpoints\//, '');
                const hash = parts[1];
                const rawDate = parts[2].split(' ')[0];
                const timestamp = parseInt(rawDate, 10) * 1000;
                checkpoints.push({
                    id,
                    hash,
                    timestamp,
                    description: id
                });
            }
        }
        return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
        return [];
    }
}
