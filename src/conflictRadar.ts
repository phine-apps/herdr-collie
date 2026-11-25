/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import * as fs from 'fs';
import {
    getRepoChangedFiles,
    getWorktreeChangedFiles,
    resolveWorktreeMergeBase
} from './reviewManager';
import {
    getCurrentGitBranch,
    listGitWorktrees
} from './worktreeManager';
import { isSameOrSubPath } from './formatters';
import { ensureWorkspaceTrustedForAction, isWorkspaceTrusted } from './workspaceTrust';

export interface WorktreeTouchEntry {
    worktreePath: string;
    branchName: string;
    isMain: boolean;
    status: string;
    dirty: boolean;
    agentId?: string;
    agentName?: string;
}

export interface FileConflictCluster {
    filePath: string;
    severity: 'high' | 'medium';
    touches: WorktreeTouchEntry[];
}

export interface ConflictScanResult {
    repoRoot: string;
    baseBranch?: string;
    worktreeCount: number;
    worktreePaths: string[];
    conflicts: FileConflictCluster[];
    scannedAt: number;
}

export interface PerWorktreeFileInput {
    worktreePath: string;
    branchName: string;
    isMain: boolean;
    agentId?: string;
    agentName?: string;
    files: Array<{
        filePath: string;
        status: string;
        dirty?: boolean;
    }>;
}

export interface ActiveAgentRef {
    id?: string;
    name?: string;
    cwd?: string;
}

export interface ConflictRadarCallbacks {
    getRepoRoot: () => Promise<string | null>;
    getActiveAgents: () => ActiveAgentRef[];
    dispatchPrompt: (
        prompt: string,
        successMsg: string,
        quickPickTitle: string,
        options?: { stageOnly?: boolean; preferredCwd?: string; preferredAgentId?: string }
    ) => Promise<boolean>;
    openWorktreeReview?: (worktreePath: string, branchName: string) => Promise<void>;
}

const DEFAULT_SCAN_MIN_INTERVAL_MS = 3000;
const NEW_CONFLICT_ALERT_COOLDOWN_MS = 30000;

export function normalizeRepoRelativePath(filePath: string): string {
    return (filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function safeRealPath(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/**
 * Pure detector that groups files touched across two or more distinct Git worktrees
 * and classifies severity:
 * - 'high': any dirty/uncommitted concurrent edit across overlapping worktrees, or 3+ worktrees touching the same file
 * - 'medium': committed divergence across 2 worktrees without uncommitted overlap
 */
export function detectOverlappingFileTouches(perWorktreeChanges: PerWorktreeFileInput[]): FileConflictCluster[] {
    const byFile = new Map<string, WorktreeTouchEntry[]>();

    for (const wt of perWorktreeChanges) {
        const resolvedWtPath = path.resolve(wt.worktreePath);
        const seenInWt = new Set<string>();

        for (const f of wt.files) {
            const rel = normalizeRepoRelativePath(f.filePath);
            if (!rel || seenInWt.has(rel)) continue;
            seenInWt.add(rel);

            let entries = byFile.get(rel);
            if (!entries) {
                entries = [];
                byFile.set(rel, entries);
            }

            // Avoid duplicate entry if same resolved worktree appears twice
            if (entries.some(e => path.resolve(e.worktreePath) === resolvedWtPath)) {
                continue;
            }

            entries.push({
                worktreePath: wt.worktreePath,
                branchName: wt.branchName || path.basename(wt.worktreePath),
                isMain: wt.isMain,
                status: f.status || 'M',
                dirty: Boolean(f.dirty),
                agentId: wt.agentId,
                agentName: wt.agentName
            });
        }
    }

    const clusters: FileConflictCluster[] = [];
    for (const [filePath, touches] of byFile.entries()) {
        if (touches.length < 2) continue;

        const dirtyCount = touches.filter(t => t.dirty).length;
        const hasMainDirty = touches.some(t => t.isMain && t.dirty);
        const severity: FileConflictCluster['severity'] =
            dirtyCount >= 2 || hasMainDirty || (dirtyCount >= 1 && touches.length >= 2) || touches.length >= 3
                ? 'high'
                : 'medium';

        const sortedTouches = [...touches].sort((a, b) => {
            if (a.dirty !== b.dirty) return a.dirty ? -1 : 1;
            if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
            return a.branchName.localeCompare(b.branchName);
        });

        clusters.push({
            filePath,
            severity,
            touches: sortedTouches
        });
    }

    clusters.sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
        if (a.touches.length !== b.touches.length) return b.touches.length - a.touches.length;
        return a.filePath.localeCompare(b.filePath);
    });

    return clusters;
}

/**
 * Formats a prompt warning a Herdr agent about parallel edits to the same file across worktrees.
 */
export function formatConflictRadarWarningPrompt(
    cluster: FileConflictCluster,
    targetWorktreeBranch?: string
): string {
    const lines: string[] = [
        `## ⚠️ Parallel Worktree Edit Warning: \`${cluster.filePath}\``,
        '',
        'The following Git worktrees are concurrently modifying this file:'
    ];

    for (const t of cluster.touches) {
        const markers = [
            t.dirty ? 'uncommitted' : 'committed',
            t.status
        ];
        if (t.agentName) {
            markers.push(`agent: ${t.agentName}`);
        }
        const currentTag = targetWorktreeBranch && t.branchName === targetWorktreeBranch ? ' **(your branch)**' : '';
        lines.push(`- \`${t.branchName}\`${currentTag} (${markers.join(', ')})`);
    }

    lines.push(
        '',
        '### Coordination Request',
        `1. Keep edits to \`${cluster.filePath}\` minimal and modular to avoid merge conflicts.`,
        '2. Avoid large unrelated formatting or import reordering in this file.',
        '3. If another worktree merges first, rebase or merge the base branch before finalizing.'
    );

    return lines.join('\n');
}

/**
 * Scans all Git worktrees of `repoRoot` in parallel and reports files touched in 2+ worktrees.
 */
export async function scanWorktreeFileConflicts(
    repoRoot: string,
    activeAgents: ActiveAgentRef[] = []
): Promise<ConflictScanResult> {
    const worktrees = await listGitWorktrees(repoRoot);
    const activeWorktrees = worktrees.filter(w => !w.bare && w.worktree && fs.existsSync(w.worktree));

    if (activeWorktrees.length < 2) {
        return {
            repoRoot,
            worktreeCount: activeWorktrees.length,
            worktreePaths: activeWorktrees.map(w => w.worktree),
            conflicts: [],
            scannedAt: Date.now()
        };
    }

    const realRepoRoot = safeRealPath(repoRoot);
    const mainWt = activeWorktrees.find(w => w.isMain || safeRealPath(w.worktree) === realRepoRoot) || activeWorktrees[0];
    const mainBranch = mainWt?.branch || await getCurrentGitBranch(repoRoot).catch(() => undefined);

    const perWorktreeResults = await Promise.all(
        activeWorktrees.map(async (wt): Promise<PerWorktreeFileInput> => {
            const realWtPath = safeRealPath(wt.worktree);
            const matchedAgent = activeAgents.find(a => a.cwd && isSameOrSubPath(safeRealPath(a.cwd), realWtPath));
            const isMainWt = Boolean(wt.isMain || realWtPath === realRepoRoot);
            const branchName = wt.branch || path.basename(wt.worktree);

            try {
                const dirtyChanges = await getRepoChangedFiles(wt.worktree);
                const dirtyPathSet = new Set(dirtyChanges.map(d => normalizeRepoRelativePath(d.filePath)));

                if (isMainWt) {
                    // For main worktree, only working tree / staged / untracked modifications count as active parallel edits
                    return {
                        worktreePath: wt.worktree,
                        branchName,
                        isMain: true,
                        agentId: matchedAgent?.id,
                        agentName: matchedAgent?.name,
                        files: dirtyChanges.map(f => ({
                            filePath: f.filePath,
                            status: f.status,
                            dirty: true
                        }))
                    };
                }

                const mergeBase = await resolveWorktreeMergeBase(wt.worktree, mainBranch, branchName);
                const branchChanges = await getWorktreeChangedFiles(wt.worktree, mergeBase.baseRef);
                return {
                    worktreePath: wt.worktree,
                    branchName,
                    isMain: false,
                    agentId: matchedAgent?.id,
                    agentName: matchedAgent?.name,
                    files: branchChanges.map(f => ({
                        filePath: f.filePath,
                        status: f.status,
                        dirty: dirtyPathSet.has(normalizeRepoRelativePath(f.filePath))
                    }))
                };
            } catch {
                return {
                    worktreePath: wt.worktree,
                    branchName,
                    isMain: isMainWt,
                    agentId: matchedAgent?.id,
                    agentName: matchedAgent?.name,
                    files: []
                };
            }
        })
    );

    const conflicts = detectOverlappingFileTouches(perWorktreeResults);
    return {
        repoRoot,
        baseBranch: mainBranch,
        worktreeCount: activeWorktrees.length,
        worktreePaths: activeWorktrees.map(w => w.worktree),
        conflicts,
        scannedAt: Date.now()
    };
}

/**
 * Coordinates periodic & event-driven conflict scanning across linked Git worktrees,
 * exposing Explorer/Editor FileDecorations, a StatusBar indicator, and QuickPick actions.
 */
export class WorktreeConflictRadar implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private readonly statusBarItem: vscode.StatusBarItem;
    private latestResult: ConflictScanResult | null = null;
    private conflictsByRelPath = new Map<string, FileConflictCluster>();
    private scanTimer: NodeJS.Timeout | null = null;
    private inFlightScan: Promise<ConflictScanResult | null> | null = null;
    private lastScanCompletedAt = 0;
    private knownHighConflictFiles = new Set<string>();
    private lastAlertAt = 0;

    constructor(private readonly callbacks: ConflictRadarCallbacks) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'herdr-collie.conflictRadar',
            vscode.StatusBarAlignment.Right,
            97
        );
        this.statusBarItem.command = 'herdr-collie.showConflictRadar';
        this.statusBarItem.hide();
        this.disposables.push(this.statusBarItem, this._onDidChangeFileDecorations);

        const winAny = vscode.window as any;
        if (typeof winAny.registerFileDecorationProvider === 'function') {
            this.disposables.push(winAny.registerFileDecorationProvider(this));
        }

        if (vscode.workspace && typeof (vscode.workspace as any).onDidSaveTextDocument === 'function') {
            this.disposables.push(
                vscode.workspace.onDidSaveTextDocument(() => {
                    this.scheduleScan(500);
                })
            );
        }
    }

    public isEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('herdr-collie');
        return config.get<boolean>('worktree.conflictRadar', true);
    }

    public getLatestResult(): ConflictScanResult | null {
        return this.latestResult;
    }

    public getConflictForFile(uriOrPath: vscode.Uri | string): FileConflictCluster | undefined {
        if (!this.latestResult || this.conflictsByRelPath.size === 0) return undefined;
        const targetPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
        if (!targetPath) return undefined;

        const resolvedTarget = safeRealPath(targetPath);
        const roots = [this.latestResult.repoRoot, ...this.latestResult.worktreePaths];
        for (const root of roots) {
            if (!root) continue;
            const resolvedRoot = safeRealPath(root);
            if (!isSameOrSubPath(resolvedTarget, resolvedRoot)) continue;
            const rel = normalizeRepoRelativePath(path.relative(resolvedRoot, resolvedTarget));
            const match = this.conflictsByRelPath.get(rel);
            if (match) return match;
        }
        return undefined;
    }

    public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this.isEnabled() || !uri || uri.scheme !== 'file') {
            return undefined;
        }
        const cluster = this.getConflictForFile(uri);
        if (!cluster) {
            return undefined;
        }

        const countLabel = cluster.touches.length <= 9 ? String(cluster.touches.length) : '+';
        const badge = cluster.severity === 'high' ? `!${countLabel}` : `~${countLabel}`;
        const branches = cluster.touches
            .map(t => `${t.branchName}${t.dirty ? '*' : ''}`)
            .join(', ');

        const dec = new vscode.FileDecoration(
            badge,
            l10n.t('Parallel edits across {0} worktrees: {1}', String(cluster.touches.length), branches),
            new vscode.ThemeColor(cluster.severity === 'high' ? 'charts.red' : 'charts.yellow')
        );
        dec.propagate = false;
        return dec;
    }

    public scheduleScan(delayMs = 600): void {
        if (!this.isEnabled() || !isWorkspaceTrusted(vscode)) {
            this.clearVisualState();
            return;
        }
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
        }
        this.scanTimer = setTimeout(() => {
            this.scanTimer = null;
            void this.scanNow(false);
        }, delayMs);
    }

    public async scanNow(force = true): Promise<ConflictScanResult | null> {
        if (!this.isEnabled() || !isWorkspaceTrusted(vscode)) {
            this.clearVisualState();
            return null;
        }

        if (this.inFlightScan) {
            return this.inFlightScan;
        }

        const now = Date.now();
        if (!force && this.latestResult && (now - this.lastScanCompletedAt) < DEFAULT_SCAN_MIN_INTERVAL_MS) {
            return this.latestResult;
        }

        const task = (async () => {
            try {
                const repoRoot = await this.callbacks.getRepoRoot();
                if (!repoRoot) {
                    this.clearVisualState();
                    return null;
                }
                const agents = this.callbacks.getActiveAgents();
                const result = await scanWorktreeFileConflicts(repoRoot, agents);
                this.applyScanResult(result, !force);
                return result;
            } catch {
                return null;
            } finally {
                this.lastScanCompletedAt = Date.now();
                this.inFlightScan = null;
            }
        })();

        this.inFlightScan = task;
        return task;
    }

    private applyScanResult(result: ConflictScanResult, notifyNewHighConflict: boolean): void {
        this.latestResult = result;
        this.conflictsByRelPath.clear();
        for (const c of result.conflicts) {
            this.conflictsByRelPath.set(normalizeRepoRelativePath(c.filePath), c);
        }

        this.updateStatusBar(result);
        this._onDidChangeFileDecorations.fire(undefined);

        const currentHighFiles = new Set(
            result.conflicts.filter(c => c.severity === 'high').map(c => c.filePath)
        );
        const newlyHigh = result.conflicts.filter(
            c => c.severity === 'high' && !this.knownHighConflictFiles.has(c.filePath)
        );
        this.knownHighConflictFiles = currentHighFiles;

        if (notifyNewHighConflict && newlyHigh.length > 0) {
            const now = Date.now();
            if ((now - this.lastAlertAt) >= NEW_CONFLICT_ALERT_COOLDOWN_MS) {
                this.lastAlertAt = now;
                void this.showNewOverlapAlert(newlyHigh[0], result.conflicts.length);
            }
        }
    }

    private updateStatusBar(result: ConflictScanResult): void {
        const count = result.conflicts.length;
        if (count === 0) {
            this.statusBarItem.hide();
            return;
        }

        const highCount = result.conflicts.filter(c => c.severity === 'high').length;
        if (highCount > 0) {
            this.statusBarItem.text = `$(warning) ${l10n.t('Overlap: {0}', count)}`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = `$(git-compare) ${l10n.t('Overlap: {0}', count)}`;
            this.statusBarItem.backgroundColor = undefined;
        }

        const previewList = result.conflicts
            .slice(0, 5)
            .map(c => `• ${c.filePath} (${c.touches.map(t => t.branchName).join(' ⚔ ')})`)
            .join('\n');
        this.statusBarItem.tooltip = `${l10n.t('{0} file(s) modified across multiple Git worktrees', String(count))}\n${previewList}`;
        this.statusBarItem.show();
    }

    private clearVisualState(): void {
        const hadData = Boolean(this.latestResult && this.latestResult.conflicts.length > 0);
        this.latestResult = null;
        this.conflictsByRelPath.clear();
        this.knownHighConflictFiles.clear();
        this.statusBarItem.hide();
        if (hadData) {
            this._onDidChangeFileDecorations.fire(undefined);
        }
    }

    private async showNewOverlapAlert(cluster: FileConflictCluster, totalCount: number): Promise<void> {
        const branches = cluster.touches.map(t => t.branchName).join(', ');
        const inspectBtn = l10n.t('Inspect Overlaps');
        const choice = await vscode.window.showWarningMessage(
            l10n.t("Parallel edit detected on '{0}' ({1}) — {2} overlapping file(s).", cluster.filePath, branches, String(totalCount)),
            inspectBtn
        );
        if (choice === inspectBtn) {
            await this.showConflictRadarWizard();
        }
    }

    public async showConflictRadarWizard(): Promise<void> {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) {
            return;
        }
        const result = await this.scanNow(true);
        if (!result || result.worktreeCount < 2) {
            vscode.window.showInformationMessage(l10n.t('Need at least 2 Git worktrees to scan for parallel edit overlaps.'));
            return;
        }

        if (result.conflicts.length === 0) {
            vscode.window.showInformationMessage(l10n.t('No overlapping file edits detected across {0} Git worktrees.', String(result.worktreeCount)));
            return;
        }

        const pickedCluster = await vscode.window.showQuickPick(
            result.conflicts.map(c => ({
                label: `${c.severity === 'high' ? '$(warning)' : '$(git-compare)'} ${c.filePath}`,
                description: `${c.touches.length} worktrees (${c.severity.toUpperCase()})`,
                detail: c.touches
                    .map(t => `${t.branchName}${t.dirty ? ' [uncommitted]' : ''}${t.agentName ? ` • ${t.agentName}` : ''}`)
                    .join('  ⚔  '),
                cluster: c
            })),
            {
                title: l10n.t('Parallel Worktree Conflict Radar ({0} overlapping files)', String(result.conflicts.length)),
                placeHolder: l10n.t('Select an overlapping file to compare or coordinate with agents')
            }
        );

        if (!pickedCluster) return;
        const cluster = pickedCluster.cluster;

        const actionPick = await vscode.window.showQuickPick([
            {
                label: `$(diff) ${l10n.t('Compare File Between Two Worktrees')}`,
                description: `${cluster.touches[0].branchName} ↔ ${cluster.touches[1].branchName}`,
                action: 'diff' as const
            },
            {
                label: `$(hubot) ${l10n.t('Warn Worktree Agent to Coordinate Edits')}`,
                description: cluster.filePath,
                action: 'notify' as const
            },
            ...(this.callbacks.openWorktreeReview
                ? [{
                    label: `$(preview) ${l10n.t('Open Worktree in Review Changes')}`,
                    description: cluster.touches.find(t => !t.isMain)?.branchName || cluster.touches[0].branchName,
                    action: 'review' as const
                }]
                : [])
        ], {
            title: cluster.filePath,
            placeHolder: l10n.t('Choose action for overlapping file {0}', cluster.filePath)
        });

        if (!actionPick) return;

        if (actionPick.action === 'diff') {
            await this.openDiffBetweenWorktrees(cluster);
        } else if (actionPick.action === 'notify') {
            const targetTouch = await this.pickWorktreeTouch(
                cluster,
                l10n.t('Select worktree to receive coordination warning for {0}', cluster.filePath)
            );
            if (!targetTouch) return;

            const prompt = formatConflictRadarWarningPrompt(cluster, targetTouch.branchName);
            await this.callbacks.dispatchPrompt(
                prompt,
                l10n.t("Sent parallel edit warning for '{0}'", cluster.filePath),
                l10n.t("Select agent to warn about '{0}':", cluster.filePath),
                {
                    preferredCwd: targetTouch.worktreePath,
                    preferredAgentId: targetTouch.agentId
                }
            );
        } else if (actionPick.action === 'review' && this.callbacks.openWorktreeReview) {
            const linked = cluster.touches.filter(t => !t.isMain);
            const targetTouch = linked.length === 1
                ? linked[0]
                : await this.pickWorktreeTouch(cluster, l10n.t('Select Worktree to Review'));
            if (targetTouch) {
                await this.callbacks.openWorktreeReview(targetTouch.worktreePath, targetTouch.branchName);
            }
        }
    }

    private async pickWorktreeTouch(
        cluster: FileConflictCluster,
        placeHolder: string
    ): Promise<WorktreeTouchEntry | undefined> {
        if (cluster.touches.length === 1) return cluster.touches[0];
        const picked = await vscode.window.showQuickPick(
            cluster.touches.map(t => ({
                label: `$(git-branch) ${t.branchName}`,
                description: `${t.dirty ? 'uncommitted' : 'committed'}${t.agentName ? ` | Agent: ${t.agentName}` : ''}`,
                detail: t.worktreePath,
                touch: t
            })),
            { placeHolder }
        );
        return picked?.touch;
    }

    private async openDiffBetweenWorktrees(cluster: FileConflictCluster): Promise<void> {
        const leftTouch = cluster.touches[0];
        const rightTouch = cluster.touches.length === 2
            ? cluster.touches[1]
            : await this.pickWorktreeTouch(
                { ...cluster, touches: cluster.touches.slice(1) },
                l10n.t('Select second worktree to compare against {0}', leftTouch.branchName)
            );

        if (!rightTouch) return;

        const leftFile = path.resolve(leftTouch.worktreePath, cluster.filePath);
        const rightFile = path.resolve(rightTouch.worktreePath, cluster.filePath);

        if (!fs.existsSync(leftFile) || !fs.existsSync(rightFile)) {
            vscode.window.showWarningMessage(
                l10n.t("Cannot diff '{0}' directly because it does not exist on disk in one of the selected worktrees.", cluster.filePath)
            );
            return;
        }

        const title = `${path.basename(cluster.filePath)} (${leftTouch.branchName} ↔ ${rightTouch.branchName})`;
        await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(leftFile),
            vscode.Uri.file(rightFile),
            title
        );
    }

    public dispose(): void {
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }
        while (this.disposables.length > 0) {
            try {
                this.disposables.pop()?.dispose();
            } catch {}
        }
    }
}
