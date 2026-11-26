/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { getErrorMessage } from '../executors';
import { isSameOrSubPath } from '../formatters';
import {
    ReviewChangeTreeItem,
    resolveDiffTargets,
    getDiffCacheDir,
    createReviewCheckpoint,
    createReviewCheckpointWithDetails,
    rollbackReviewCheckpoint,
    listReviewCheckpoints
} from '../reviewManager';
import {
    listGitWorktrees,
    getRepoRoot,
    getCurrentGitBranch,
    formatWorktreeScorecardBadge
} from '../worktreeManager';
import { HerdrWorkspaceTreeItem } from '../workspaceDragAndDrop';
import { ensureWorkspaceTrustedForAction } from '../workspaceTrust';
import { CommandContext } from './types';

export function registerReviewCommands(context: vscode.ExtensionContext, ctx: CommandContext): void {
    const addReviewCommentDisposable = vscode.commands.registerCommand('herdr-collie.addReviewComment', async (uriArg?: vscode.Uri) => {
        const editor = vscode.window.activeTextEditor;
        const uri = uriArg || editor?.document.uri;
        if (!uri) return;
        if (isSameOrSubPath(uri.fsPath, getDiffCacheDir())) {
            vscode.window.showWarningMessage(l10n.t('Cannot add a review comment to a temporary baseline file. Please add comments on the working-tree side of the diff.'));
            return;
        }

        let startLine = 1;
        let endLine = 1;
        let snippet = '';

        if (editor && editor.document.uri.toString() === uri.toString()) {
            const sel = editor.selection;
            startLine = sel.start.line + 1;
            endLine = sel.end.line + 1;
            snippet = editor.document.getText(sel).trim();
            if (!snippet && editor.document.lineCount >= startLine) {
                snippet = editor.document.lineAt(startLine - 1).text.trim();
            }
        }

        const lineRangeText = startLine === endLine ? l10n.t('Line {0}', startLine) : l10n.t('Lines {0}-{1}', startLine, endLine);
        const comment = await vscode.window.showInputBox({
            title: l10n.t('Add Review Comment'),
            prompt: `${l10n.t('Enter review feedback for selected lines')} (${lineRangeText})`,
            placeHolder: l10n.t('e.g. Handle error with custom exception, remove console.log')
        });

        if (!comment || !comment.trim()) return;

        const effectiveRepoRoot = await ctx.reviewChangesProvider.getEffectiveRepoRoot();
        ctx.reviewController.addCommentFromEditor(
            uri,
            startLine,
            endLine,
            comment.trim(),
            snippet || undefined,
            effectiveRepoRoot || undefined
        );
        vscode.window.showInformationMessage(l10n.t('Added review comment on {0} ({1})', path.basename(uri.fsPath), lineRangeText));
    });

    const submitReviewDisposable = vscode.commands.registerCommand('herdr-collie.submitReview', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const count = ctx.reviewController.commentCount;
        if (count === 0) {
            vscode.window.showInformationMessage(l10n.t('No pending review comments to submit'));
            return;
        }

        const submitModePick = await vscode.window.showQuickPick([
            {
                label: `$(send) ` + l10n.t('Submit Review (Code Fixes Only)'),
                description: l10n.t('Send inline review comments to agent'),
                mode: 'standard' as const
            },
            {
                label: `$(book) ` + l10n.t('Submit Review + Crystallize Rule to AGENTS.md'),
                description: l10n.t('Fix code and append generalizable rule to AGENTS.md'),
                mode: 'crystallize' as const
            },
            {
                label: `$(edit) ` + l10n.t('Submit Review with Custom Instruction...'),
                description: l10n.t('Append additional instructions to review feedback'),
                mode: 'custom' as const
            },
            {
                label: `$(terminal) ` + l10n.t('Stage Review in Agent Input (Draft Mode)'),
                description: l10n.t('Paste review into agent input without pressing Enter'),
                mode: 'stage' as const
            },
            {
                label: `$(clippy) ` + l10n.t('Copy Review Prompt to Clipboard'),
                description: l10n.t('Copy formatted review markdown to clipboard'),
                mode: 'clipboard' as const
            }
        ], {
            title: l10n.t('Submit Review to Agent'),
            placeHolder: l10n.t('Select review submission mode')
        });

        if (!submitModePick) return;

        let customInstruction: string | undefined;
        if (submitModePick.mode === 'custom') {
            const input = await vscode.window.showInputBox({
                title: l10n.t('Submit Review with Custom Instruction...'),
                prompt: l10n.t('Enter custom instruction for the agent'),
                placeHolder: l10n.t('e.g. Run unit tests after applying review fixes')
            });
            if (!input || !input.trim()) return;
            customInstruction = input.trim();
        }

        const reviewTarget = ctx.reviewChangesProvider.getReviewTarget();
        let currentBranch: string | undefined;
        let repoRoot: string | null = null;
        if (reviewTarget && reviewTarget.kind === 'worktree') {
            repoRoot = reviewTarget.worktreePath;
            try {
                currentBranch = reviewTarget.branchName || await getCurrentGitBranch(repoRoot);
            } catch {}
        } else {
            try {
                repoRoot = await ctx.reviewChangesProvider.getEffectiveRepoRoot() || await ctx.resolveMainRepoRoot();
                if (repoRoot) {
                    currentBranch = await getCurrentGitBranch(repoRoot);
                }
            } catch {}
        }

        const sendTargetOptions = reviewTarget && reviewTarget.kind === 'worktree'
            ? { preferredCwd: reviewTarget.worktreePath, preferredAgentId: reviewTarget.agentId }
            : {};

        const delivered = await ctx.reviewController.submitSafely(
            async (prompt) => {
                if (submitModePick.mode === 'clipboard') {
                    await vscode.env.clipboard.writeText(prompt);
                    vscode.window.showInformationMessage(l10n.t('Copied review prompt ({0} comments) to clipboard', count));
                    return true;
                }
                if (submitModePick.mode === 'stage') {
                    return await ctx.sendToHerdr(
                        prompt,
                        l10n.t('Staged review ({0} comments) in input', count),
                        l10n.t('Select agent to stage review feedback:'),
                        { stageOnly: true, ...sendTargetOptions }
                    );
                }
                return await ctx.sendToHerdr(
                    prompt,
                    l10n.t('Submitted review ({0} comments)', count),
                    l10n.t('Select agent to receive review feedback:'),
                    sendTargetOptions
                );
            },
            {
                branchName: currentBranch,
                crystallizeRule: submitModePick.mode === 'crystallize',
                targetRuleFile: 'AGENTS.md',
                customInstruction
            }
        );

        if (delivered && repoRoot && submitModePick.mode !== 'clipboard' && submitModePick.mode !== 'crystallize') {
            try {
                const cp = await createReviewCheckpoint(repoRoot, 'pre-review-submit');
                if (cp) {
                    ctx.reviewChangesProvider.setBaseCheckpoint(cp);
                }
            } catch {}
        }
    });

    const clearReviewDisposable = vscode.commands.registerCommand('herdr-collie.clearReview', async () => {
        const count = ctx.reviewController.commentCount;
        if (count === 0) {
            vscode.window.showInformationMessage(l10n.t('No pending review comments to submit'));
            return;
        }
        ctx.reviewController.clearAll();
        vscode.window.showInformationMessage(l10n.t('Cleared {0} pending review comments', count));
    });

    const openDiffDisposable = vscode.commands.registerCommand('herdr-collie.openDiff', async (item?: ReviewChangeTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (!item || item.isFolder) return;
        try {
            const baseRef = ctx.reviewChangesProvider.getEffectiveBaseRef();
            const baseLabel = ctx.reviewChangesProvider.getEffectiveBaseLabel();
            const { originalPath, workingPath, title } = await resolveDiffTargets(item.change, item.repoRoot, baseRef, baseLabel);
            const originalUri = vscode.Uri.file(originalPath);
            const workingUri = vscode.Uri.file(workingPath);
            await vscode.commands.executeCommand('vscode.diff', originalUri, workingUri, title);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(getErrorMessage(err));
        }
    });

    const toggleReviewViewModeDisposable = vscode.commands.registerCommand('herdr-collie.toggleReviewViewMode', () => {
        const newMode = ctx.reviewChangesProvider.toggleViewMode();
        ctx.updateTreeViewDescriptions();
        const modeLabel = newMode === 'tree' ? l10n.t('Tree') : l10n.t('Flat');
        vscode.window.setStatusBarMessage(l10n.t('Review Changes View: {0}', modeLabel), 3000);
    });

    const refreshReviewChangesDisposable = vscode.commands.registerCommand('herdr-collie.refreshReviewChanges', () => {
        ctx.reviewChangesProvider.refresh();
    });

    const createReviewCheckpointDisposable = vscode.commands.registerCommand('herdr-collie.createReviewCheckpoint', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const repoRoot = await ctx.reviewChangesProvider.getEffectiveRepoRoot();
        if (!repoRoot) {
            vscode.window.showWarningMessage(l10n.t('The current workspace is not a Git repository.'));
            return;
        }
        const { checkpoint, error } = await createReviewCheckpointWithDetails(repoRoot);
        if (checkpoint) {
            ctx.reviewChangesProvider.setBaseCheckpoint(checkpoint);
            vscode.window.showInformationMessage(l10n.t('Created review checkpoint: {0}', checkpoint.id));
        } else {
            vscode.window.showErrorMessage(l10n.t('Failed to create review checkpoint: {0}', error || l10n.t('Unknown Git error')));
        }
    });

    const rollbackReviewCheckpointDisposable = vscode.commands.registerCommand('herdr-collie.rollbackReviewCheckpoint', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const repoRoot = await ctx.reviewChangesProvider.getEffectiveRepoRoot();
        if (!repoRoot) {
            vscode.window.showWarningMessage(l10n.t('The current workspace is not a Git repository.'));
            return;
        }
        const checkpoints = await listReviewCheckpoints(repoRoot);
        if (checkpoints.length === 0) {
            vscode.window.showInformationMessage(l10n.t('No checkpoints found for this repository'));
            return;
        }
        const items = checkpoints.map(c => ({
            label: `$(bookmark) ${c.id}`,
            description: new Date(c.timestamp).toLocaleString(),
            detail: c.hash.slice(0, 8),
            checkpoint: c
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: l10n.t('Select checkpoint to rollback to:')
        });
        if (!picked) return;

        const confirm = await vscode.window.showWarningMessage(
            l10n.t("Are you sure you want to rollback to checkpoint '{0}'? Any uncommitted changes will be lost.", picked.checkpoint.id),
            { modal: true },
            l10n.t('Rollback'),
            l10n.t('Cancel')
        );
        if (confirm !== l10n.t('Rollback')) return;

        const success = await rollbackReviewCheckpoint(repoRoot, `refs/herdr/checkpoints/${picked.checkpoint.id}`);
        if (success) {
            ctx.reviewChangesProvider.setBaseCheckpoint(null);
            vscode.window.showInformationMessage(l10n.t('Rolled back to checkpoint: {0}', picked.checkpoint.id));
            ctx.reviewChangesProvider.refresh();
        } else {
            vscode.window.showErrorMessage(l10n.t('Failed to rollback to checkpoint: {0}', picked.checkpoint.id));
        }
    });

    const selectReviewTargetDisposable = vscode.commands.registerCommand('herdr-collie.selectReviewTarget', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const repoRoot = await ctx.resolveMainRepoRoot();
        if (!repoRoot) {
            vscode.window.showWarningMessage(l10n.t('The current workspace is not a Git repository.'));
            return;
        }

        const worktrees = await listGitWorktrees(repoRoot);
        const linkedWorktrees = worktrees.filter(w => !w.isMain && w.worktree !== repoRoot);
        const currentAgents = ctx.getAgentItems();
        const activeTarget = ctx.reviewChangesProvider.getReviewTarget();
        const scorecards = await ctx.loadWorktreeScorecards(repoRoot, linkedWorktrees);

        type ReviewTargetPick = vscode.QuickPickItem & {
            targetKind: 'current' | 'worktree';
            worktreePath?: string;
            branchName?: string;
            labelText?: string;
        };

        const items: ReviewTargetPick[] = [
            {
                label: `$(home) ${l10n.t('Current Workspace')}`,
                description: !activeTarget || activeTarget.kind === 'current' ? l10n.t('(active)') : path.basename(repoRoot),
                detail: l10n.t('Review uncommitted changes in the open workspace'),
                targetKind: 'current'
            },
            ...linkedWorktrees.map(wt => {
                const branchLabel = wt.branch || path.basename(wt.worktree);
                const matchedAgent = currentAgents.find(a => a.cwd && isSameOrSubPath(a.cwd, wt.worktree));
                const agentText = matchedAgent
                    ? l10n.t('Agent: {0}', typeof matchedAgent.label === 'string' ? matchedAgent.label : (matchedAgent.rawId || ''))
                    : undefined;
                const card = scorecards.get(wt.worktree);
                const badgeText = card ? formatWorktreeScorecardBadge(card) : undefined;
                const detail = [badgeText, agentText].filter(Boolean).join(' | ') || undefined;
                const isSelected = activeTarget?.kind === 'worktree' && activeTarget.worktreePath === wt.worktree;
                return {
                    label: `$(git-branch) ${branchLabel}`,
                    description: isSelected ? `${l10n.t('(active)')} | ${wt.worktree}` : wt.worktree,
                    detail,
                    targetKind: 'worktree' as const,
                    worktreePath: wt.worktree,
                    branchName: wt.branch,
                    labelText: branchLabel
                };
            })
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: l10n.t('Select Worktree to Review'),
            placeHolder: l10n.t('Choose Current Workspace or a linked Git worktree')
        });
        if (!picked) return;

        if (picked.targetKind === 'current') {
            ctx.reviewChangesProvider.setReviewTarget(null);
            ctx.updateTreeViewDescriptions();
            vscode.window.setStatusBarMessage(l10n.t('Reviewing current workspace'), 3000);
            return;
        }

        if (picked.worktreePath) {
            await ctx.activateWorktreeReviewTarget(repoRoot, picked.worktreePath, picked.branchName, picked.labelText);
        }
    });

    const reviewWorktreeDisposable = vscode.commands.registerCommand('herdr-collie.reviewWorktree', async (item?: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        if (item?.cwd) {
            const repoRoot = await ctx.resolveMainRepoRoot(item.cwd);
            if (!repoRoot) {
                vscode.window.showWarningMessage(l10n.t('The current workspace is not a Git repository.'));
                return;
            }
            const labelHint = item.branchName || (typeof item.label === 'string' ? item.label : path.basename(item.cwd));
            await ctx.activateWorktreeReviewTarget(repoRoot, item.cwd, item.branchName, labelHint);
            return;
        }
        await vscode.commands.executeCommand('herdr-collie.selectReviewTarget');
    });

    context.subscriptions.push(
        addReviewCommentDisposable,
        submitReviewDisposable,
        clearReviewDisposable,
        openDiffDisposable,
        toggleReviewViewModeDisposable,
        refreshReviewChangesDisposable,
        createReviewCheckpointDisposable,
        rollbackReviewCheckpointDisposable,
        selectReviewTargetDisposable,
        reviewWorktreeDisposable
    );
}
