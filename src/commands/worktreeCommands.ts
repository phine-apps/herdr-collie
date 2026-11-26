/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as path from 'path';
import { execHerdr, getErrorMessage, runGitCmd, isCommandAvailable } from '../executors';
import { formatFailingPrChecksPrompt, isSameOrSubPath } from '../formatters';
import { promptAndDispatchTask } from '../microTaskManager';
import { resolveWorktreeMergeBase } from '../reviewManager';
import { launchSwarmPlaybookWizard } from '../swarmPlaybooks';
import {
    launchWorktreeAgentWizard,
    listGitWorktrees,
    removeWorktree,
    mergeWorktreeBranch,
    verifyWorktreeMerge,
    formatMergeConflictPrompt,
    formatCreatePullRequestPrompt,
    pushAndCreatePullRequestWithGh,
    manageIntegrationsWizard,
    getCurrentGitBranch,
    formatWorktreeScorecardBadge,
    fetchFailingPrChecksWithLogs
} from '../worktreeManager';
import { HerdrWorkspaceTreeItem } from '../workspaceDragAndDrop';
import { ensureWorkspaceTrustedForAction } from '../workspaceTrust';
import { CommandContext } from './types';

export function registerWorktreeCommands(context: vscode.ExtensionContext, ctx: CommandContext): void {
    const launchWorktreeAgentDisposable = vscode.commands.registerCommand('herdr-collie.launchWorktreeAgent', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        await launchWorktreeAgentWizard(ctx.getActiveSidebarSession(), () => ctx.refreshAllProviders(), ctx.getSocketClient());
    });

    const launchSwarmPlaybookDisposable = vscode.commands.registerCommand('herdr-collie.launchSwarmPlaybook', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        await launchSwarmPlaybookWizard(ctx.getActiveSidebarSession(), () => ctx.refreshAllProviders(), ctx.getSocketClient());
    });

    const mergeWorktreeDisposable = vscode.commands.registerCommand('herdr-collie.mergeWorktree', async (item?: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const repoRoot = await ctx.resolveMainRepoRoot(item?.cwd);
        if (!repoRoot) {
            vscode.window.showErrorMessage(l10n.t('The current workspace is not a Git repository.'));
            return;
        }

        let branchToMerge = item?.branchName;
        if (!branchToMerge) {
            const worktrees = await listGitWorktrees(repoRoot);
            const candidates = worktrees.filter(w => w.branch && !w.isMain && w.worktree !== repoRoot);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No active Git worktree branches found to merge.'));
                return;
            }
            const scorecards = await ctx.loadWorktreeScorecards(repoRoot, candidates);
            const selected = await vscode.window.showQuickPick(candidates.map(c => {
                const card = scorecards.get(c.worktree);
                return {
                    label: `$(git-branch) ${c.branch}`,
                    description: c.worktree,
                    detail: card ? formatWorktreeScorecardBadge(card) : undefined,
                    branch: c.branch!
                };
            }), {
                title: l10n.t('Merge Branch'),
                placeHolder: l10n.t('Select Git Worktree branch to merge into current branch ({0})', path.basename(repoRoot))
            });
            if (!selected) return;
            branchToMerge = selected.branch;
        }

        const mergeBtn = l10n.t('Merge Branch');
        const cancelBtn = l10n.t('Dismiss');
        const confirm = await vscode.window.showInformationMessage(
            l10n.t("Are you sure you want to merge worktree branch '{0}' into '{1}'?", branchToMerge, path.basename(repoRoot)),
            mergeBtn,
            cancelBtn
        );
        if (confirm !== mergeBtn) return;

        try {
            const verification = await verifyWorktreeMerge(repoRoot, branchToMerge, item?.cwd);
            if (!verification.canMerge) {
                const delegateBtn = l10n.t('Delegate Resolution to Agent');
                const mergeAnywayBtn = l10n.t('Merge Anyway');
                const buttons = verification.hasConflicts
                    ? [delegateBtn, cancelBtn]
                    : [delegateBtn, mergeAnywayBtn, cancelBtn];

                const warningChoice = await vscode.window.showWarningMessage(
                    l10n.t("⚠️ Pre-merge check detected conflicts or uncommitted changes on '{0}'. Delegate resolution to worktree agent?", branchToMerge),
                    ...buttons
                );

                if (warningChoice === delegateBtn) {
                    const conflictPrompt = formatMergeConflictPrompt(branchToMerge, verification.targetBranch, verification);
                    await promptAndDispatchTask(
                        conflictPrompt,
                        l10n.t("Resolve Merge Blockers on '{0}'", branchToMerge),
                        { socketClient: ctx.getSocketClient(), sessionName: ctx.getActiveSidebarSession(), cwd: item?.cwd || repoRoot }
                    );
                    return;
                }
                if (warningChoice !== mergeAnywayBtn) {
                    return;
                }
            }
        } catch {
            // Proceed to standard merge if pre-verification cannot run
        }

        try {
            const out = await mergeWorktreeBranch(repoRoot, branchToMerge);
            vscode.window.showInformationMessage(l10n.t("Merged '{0}' successfully.\n{1}", branchToMerge, out.trim()));
            ctx.refreshAllProviders();
        } catch (e: unknown) {
            const errMsg = getErrorMessage(e);
            await runGitCmd(['merge', '--abort'], repoRoot).catch(() => {});

            const delegateBtn = l10n.t('Delegate Resolution to Agent');
            const action = await vscode.window.showErrorMessage(
                l10n.t('Merge failed: {0}', errMsg),
                delegateBtn,
                cancelBtn
            );
            if (action === delegateBtn) {
                const targetBranch = await getCurrentGitBranch(repoRoot);
                const conflictPrompt = formatMergeConflictPrompt(branchToMerge, targetBranch, { errorDetails: errMsg });
                await promptAndDispatchTask(
                    conflictPrompt,
                    l10n.t("Resolve Merge Blockers on '{0}'", branchToMerge),
                    { socketClient: ctx.getSocketClient(), sessionName: ctx.getActiveSidebarSession(), cwd: item?.cwd || repoRoot }
                );
            }
        }
    });

    const removeWorktreeDisposable = vscode.commands.registerCommand('herdr-collie.removeWorktree', async (item?: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        let targetPath = item?.cwd;
        const targetId = item?.rawId || (item?.id ? item.id.split(':')[0] : undefined);
        let targetLabel = item?.label || 'Worktree';

        const repoRoot = await ctx.resolveMainRepoRoot(targetPath);
        if (!repoRoot) return;

        if (!targetPath) {
            const worktrees = await listGitWorktrees(repoRoot);
            const candidates = worktrees.filter(w => !w.isMain && w.worktree !== repoRoot);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No active Git worktrees found to remove.'));
                return;
            }
            const selected = await vscode.window.showQuickPick(candidates.map(c => ({
                label: `$(trash) ${c.branch || path.basename(c.worktree)}`,
                description: c.worktree,
                worktree: c.worktree,
                branch: c.branch
            })), {
                title: l10n.t('Remove Worktree'),
                placeHolder: l10n.t('Select Git Worktree to remove')
            });
            if (!selected) return;
            targetPath = selected.worktree;
            targetLabel = selected.branch || path.basename(targetPath) || 'Worktree';
        }

        const worktrees = await listGitWorktrees(repoRoot);
        const isLinkedWorktree = worktrees.some(w => w.worktree === targetPath && !w.isMain);
        if (!isLinkedWorktree) {
            const closeBtn = l10n.t('Close Workspace');
            const confirm = await vscode.window.showWarningMessage(
                l10n.t("'{0}' is not a linked Git worktree. Would you like to close the Herdr workspace without deleting any files?", targetLabel),
                { modal: true },
                closeBtn
            );
            if (confirm !== closeBtn) return;
            if (targetId) {
                execHerdr(['--session', ctx.getActiveSidebarSession(), 'workspace', 'close', targetId], () => {
                    ctx.refreshAllProviders();
                });
            }
            return;
        }

        const removeBtn = l10n.t('Remove Worktree');
        const confirm = await vscode.window.showWarningMessage(
            l10n.t("Are you sure you want to remove worktree '{0}' ({1})? The directory and its Herdr workspace will be deleted.", targetLabel, targetPath),
            { modal: true },
            removeBtn
        );
        if (confirm !== removeBtn) return;

        try {
            if (targetId) {
                await new Promise<void>((resolve) => {
                    execHerdr(['--session', ctx.getActiveSidebarSession(), 'workspace', 'close', targetId], (err) => {
                        if (err) {
                            console.warn('[herdr-collie] Failed to close Herdr workspace before removing worktree:', err);
                        }
                        resolve();
                    });
                });
            }
            await removeWorktree(repoRoot, targetPath, true);
            vscode.window.showInformationMessage(l10n.t("Worktree '{0}' removed.", targetLabel));
            ctx.refreshAllProviders();
        } catch (e: unknown) {
            vscode.window.showErrorMessage(l10n.t('Failed to remove worktree: {0}', getErrorMessage(e)));
        }
    });

    const createPullRequestFromWorktreeDisposable = vscode.commands.registerCommand('herdr-collie.createPullRequestFromWorktree', async (item?: HerdrWorkspaceTreeItem) => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        const repoRoot = await ctx.resolveMainRepoRoot(item?.cwd);
        if (!repoRoot) {
            vscode.window.showWarningMessage(l10n.t('The current workspace is not a Git repository.'));
            return;
        }

        let worktreePath = item?.cwd;
        let branchName = item?.branchName;

        if (!worktreePath || !branchName) {
            const activeReview = ctx.reviewChangesProvider.getReviewTarget();
            if (activeReview?.kind === 'worktree' && (!item || item.cwd === activeReview.worktreePath)) {
                worktreePath = activeReview.worktreePath;
                branchName = activeReview.branchName;
            }
        }

        if (worktreePath && !branchName) {
            branchName = await getCurrentGitBranch(worktreePath).catch(() => undefined);
        }

        if (!worktreePath || !branchName) {
            const worktrees = await listGitWorktrees(repoRoot);
            const candidates = worktrees.filter(w => w.branch && !w.isMain && w.worktree !== repoRoot);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No active Git worktree branches found.'));
                return;
            }
            const scorecards = await ctx.loadWorktreeScorecards(repoRoot, candidates);
            const selectedWt = await vscode.window.showQuickPick(
                candidates.map(c => {
                    const card = scorecards.get(c.worktree);
                    return {
                        label: `$(git-branch) ${c.branch}`,
                        description: c.worktree,
                        detail: card ? formatWorktreeScorecardBadge(card) : undefined,
                        worktree: c.worktree,
                        branch: c.branch!
                    };
                }),
                {
                    title: l10n.t('Select Worktree Branch for PR'),
                    placeHolder: l10n.t('Select Worktree Branch for PR')
                }
            );
            if (!selectedWt) return;
            worktreePath = selectedWt.worktree;
            branchName = selectedWt.branch;
        }

        const currentMainBranch = await getCurrentGitBranch(repoRoot).catch(() => 'main');
        const mergeBase = await resolveWorktreeMergeBase(worktreePath, currentMainBranch, branchName);
        const baseBranch = mergeBase.baseBranch || currentMainBranch || 'main';

        const actionPick = await vscode.window.showQuickPick([
            {
                label: `$(hubot) ${l10n.t('Delegate Commit, Push & PR to Agent')}`,
                description: `gh pr create (${branchName} -> ${baseBranch})`,
                detail: l10n.t('Ask the worktree agent to review diff, commit, push, and run gh pr create'),
                action: 'delegate' as const
            },
            {
                label: `$(git-pull-request-create) ${l10n.t('Push & Create PR via GitHub CLI (gh)')}`,
                description: `${branchName} -> ${baseBranch}`,
                detail: l10n.t('Push branch {0} and create a PR against {1}', branchName, baseBranch),
                action: 'gh' as const
            },
            {
                label: `$(git-merge) ${l10n.t('Merge Branch into Current Branch')}`,
                description: `${branchName} -> ${currentMainBranch}`,
                detail: l10n.t('Merge {0} locally into the current branch', branchName),
                action: 'merge' as const
            },
            {
                label: `$(error) ${l10n.t('Send Failing PR Checks to Agent')}`,
                description: `gh pr checks (${branchName})`,
                detail: l10n.t('Fetch failing CI checks and logs for {0} and send to the worktree agent', branchName),
                action: 'fix-checks' as const
            }
        ], {
            title: l10n.t('Create Pull Request / Integrate Worktree ({0})', branchName),
            placeHolder: l10n.t('Select how to integrate or publish worktree changes')
        });

        if (!actionPick) return;

        if (actionPick.action === 'fix-checks') {
            if (!(await isCommandAvailable('gh'))) {
                vscode.window.showWarningMessage(
                    l10n.t('GitHub CLI (gh) is not installed or not in PATH.')
                );
                return;
            }
            const checkResult = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: l10n.t('Checking failing PR checks for {0}...', branchName),
                    cancellable: false
                },
                async () => await fetchFailingPrChecksWithLogs(worktreePath!, branchName!)
            );

            if (checkResult.prError) {
                vscode.window.showWarningMessage(checkResult.prError);
                return;
            }
            if (checkResult.checks.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No failing PR checks found for {0}.', branchName));
                return;
            }

            const prompt = formatFailingPrChecksPrompt(branchName, checkResult.checks, checkResult.logSnippet);
            const matchedAgent = ctx.getAgentItems().find(
                a => a.cwd && isSameOrSubPath(a.cwd, worktreePath!)
            );
            await ctx.sendToHerdr(
                prompt,
                l10n.t('Prompt sent to agent to fix {0} failing PR check(s) on {1}', checkResult.checks.length, branchName),
                l10n.t('Select target agent to fix failing PR checks on {0}:', branchName),
                {
                    preferredCwd: worktreePath,
                    preferredAgentId: matchedAgent?.rawId || (matchedAgent?.id ? matchedAgent.id.split(':')[0] : undefined)
                }
            );
            return;
        }

        if (actionPick.action === 'merge') {
            await vscode.commands.executeCommand(
                'herdr-collie.mergeWorktree',
                item || ({ cwd: worktreePath, branchName } as HerdrWorkspaceTreeItem)
            );
            return;
        }

        if (actionPick.action === 'delegate') {
            const customInstruction = await vscode.window.showInputBox({
                title: l10n.t('Create Pull Request / Integrate Worktree ({0})', branchName),
                prompt: l10n.t('Additional instruction for PR (optional)'),
                placeHolder: l10n.t('e.g. Include unit test results and mark as draft')
            });
            if (customInstruction === undefined) return;

            const prompt = formatCreatePullRequestPrompt(branchName, baseBranch, customInstruction.trim() || undefined);
            const matchedAgent = ctx.getAgentItems().find(
                a => a.cwd && isSameOrSubPath(a.cwd, worktreePath!)
            );
            await ctx.sendToHerdr(
                prompt,
                l10n.t('Prompt sent to agent to create PR for {0}', branchName),
                l10n.t('Select target agent to create PR for {0}:', branchName),
                {
                    preferredCwd: worktreePath,
                    preferredAgentId: matchedAgent?.rawId || (matchedAgent?.id ? matchedAgent.id.split(':')[0] : undefined)
                }
            );
            return;
        }

        const prTitle = await vscode.window.showInputBox({
            title: l10n.t('Pull Request Title'),
            prompt: l10n.t('Enter title for Pull Request ({0} -> {1})', branchName, baseBranch),
            value: branchName
        });
        if (!prTitle || !prTitle.trim()) return;

        try {
            const prUrl = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: l10n.t('Pushing {0} and creating Pull Request...', branchName),
                    cancellable: false
                },
                async () => await pushAndCreatePullRequestWithGh(worktreePath!, branchName!, baseBranch, prTitle.trim())
            );
            const openBtn = l10n.t('Open PR');
            if (/^https?:\/\//i.test(prUrl)) {
                const choice = await vscode.window.showInformationMessage(
                    l10n.t('Created Pull Request: {0}', prUrl),
                    openBtn
                );
                if (choice === openBtn) {
                    await vscode.env.openExternal(vscode.Uri.parse(prUrl));
                }
            } else {
                vscode.window.showInformationMessage(l10n.t('Created Pull Request: {0}', prUrl));
            }
        } catch (err: unknown) {
            vscode.window.showErrorMessage(l10n.t('Failed to create Pull Request: {0}', getErrorMessage(err)));
        }
    });

    const manageIntegrationsDisposable = vscode.commands.registerCommand('herdr-collie.manageIntegrations', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        await manageIntegrationsWizard(ctx.getSocketClient());
    });

    const showConflictRadarDisposable = vscode.commands.registerCommand('herdr-collie.showConflictRadar', async () => {
        if (!(await ensureWorkspaceTrustedForAction(vscode))) return;
        await ctx.getConflictRadar()?.showConflictRadarWizard();
    });

    context.subscriptions.push(
        launchWorktreeAgentDisposable,
        launchSwarmPlaybookDisposable,
        mergeWorktreeDisposable,
        removeWorktreeDisposable,
        createPullRequestFromWorktreeDisposable,
        manageIntegrationsDisposable,
        showConflictRadarDisposable
    );
}
