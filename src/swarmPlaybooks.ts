/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import type * as vscodeTypes from 'vscode';
import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import * as path from 'path';
import { ParsedIntegrationInfo } from './parsers';
import { HerdrSocketClient } from './socketClient';
import { ensureWorkspaceTrustedForAction } from './workspaceTrust';
import {
    AgentOptionItem,
    bootstrapWorktreeEnvironment,
    collectExistingAgentNames,
    createHerdrWorkspace,
    CreateHerdrWorkspaceOptions,
    CreateHerdrWorkspaceResult,
    createWorktree,
    ensureAgentIntegrationReady,
    fetchIntegrationStatuses,
    getCurrentGitBranch,
    getInstalledAgentOptions,
    getRepoRoot,
    resolveMainRepoRootFromPath,
    getWorktreeBootstrapOptions,
    listGitBranches,
    resolveWorktreePath,
    sanitizeAgentName,
    sanitizeBranchSlug,
    splitHerdrPane,
    SplitHerdrPaneOptions,
    startAgentInPane,
    StartAgentInPaneOptions,
    StartAgentInPaneResult,
    validateBranchName,
    WorktreeBootstrapOptions,
    WorktreeBootstrapResult
} from './worktreeManager';

let vscode: typeof vscodeTypes;
try {
    vscode = require('vscode');
} catch {
    // Running outside VS Code runtime (e.g. headless unit tests)
}

export type PlaybookKind = 'best-of-n' | 'implement-review';
export type ImplementReviewTopology = 'new-worktree' | 'current-workspace';

export interface AgentSlotConfig {
    label?: string;
    cmd: string;
    agentKind?: string;
}

export interface BestOfNCandidatePlan {
    index: number;
    total: number;
    branchName: string;
    worktreePath: string;
    agentName: string;
    agentCmd: string;
    agentKind?: string;
    prompt: string;
}

export interface ImplementReviewPlan {
    topology: ImplementReviewTopology;
    branchName?: string;
    baseBranch?: string;
    worktreePath: string;
    workspaceLabel: string;
    taskPrompt: string;
    implementer: {
        agentName: string;
        agentCmd: string;
        agentKind?: string;
        prompt: string;
    };
    reviewer: {
        agentName: string;
        agentCmd: string;
        agentKind?: string;
        prompt: string;
    };
}

export interface PlaybookAgentLaunchOutcome {
    role: string;
    agentName: string;
    branchName?: string;
    worktreePath: string;
    workspaceId?: string;
    paneId?: string;
    started: boolean;
    prompted: boolean;
    error?: string;
}

export interface PlaybookLaunchResult {
    playbook: PlaybookKind;
    launched: PlaybookAgentLaunchOutcome[];
    failures: PlaybookAgentLaunchOutcome[];
    primaryWorkspaceId?: string;
    primaryWorktreePath?: string;
    warnings?: string[];
}

export interface PlaybookExecutionDeps {
    createWorktreeFn?: (repoRoot: string, branchName: string, worktreePath: string, baseBranch?: string) => Promise<void>;
    bootstrapWorktreeFn?: (repoRoot: string, worktreePath: string, options?: WorktreeBootstrapOptions) => Promise<WorktreeBootstrapResult>;
    createHerdrWorkspaceFn?: (options: CreateHerdrWorkspaceOptions) => Promise<CreateHerdrWorkspaceResult>;
    splitHerdrPaneFn?: (options: SplitHerdrPaneOptions) => Promise<string>;
    startAgentInPaneFn?: (options: StartAgentInPaneOptions) => Promise<StartAgentInPaneResult>;
}

/**
 * Validates a Best-of-N branch prefix after stripping trailing slashes and rejecting invalid Git ref forms.
 */
export function validatePlaybookBranchPrefix(val: string): string | null {
    const trimmed = (val || '').trim().replace(/\/+$/, '');
    const baseErr = validateBranchName(trimmed);
    if (baseErr) {
        return baseErr;
    }
    if (trimmed.startsWith('/') || trimmed.endsWith('.') || trimmed.endsWith('.lock') || trimmed === '@') {
        return l10n.t('Branch name contains invalid Git ref characters');
    }
    return null;
}

/**
 * Generates `count` unique valid Git branch names from `prefix`, skipping collisions in `existingBranches`,
 * normalized branch slugs, and existing worktree directories on disk.
 */
export function generatePlaybookBranchNames(
    prefix: string,
    count: number,
    existingBranches: string[] = [],
    options?: {
        repoRoot?: string;
        locationPref?: 'sibling' | '.worktrees';
    }
): string[] {
    const err = validatePlaybookBranchPrefix(prefix);
    if (err) {
        throw new Error(err);
    }
    const trimmed = (prefix || '').trim().replace(/\/+$/, '');
    if (count < 1 || !Number.isFinite(count)) {
        return [];
    }

    const existingSet = new Set(existingBranches.map(b => b.trim()).filter(Boolean));
    const existingSlugSet = new Set(existingBranches.map(b => sanitizeBranchSlug(b.trim())).filter(Boolean));
    const result: string[] = [];
    let suffix = 1;
    while (result.length < count) {
        const candidate = `${trimmed}-${suffix}`;
        const candidateSlug = sanitizeBranchSlug(candidate);
        suffix++;
        if (existingSet.has(candidate) || existingSlugSet.has(candidateSlug)) {
            continue;
        }
        if (options?.repoRoot) {
            const wtPath = resolveWorktreePath(options.repoRoot, candidate, options.locationPref || 'sibling');
            if (fs.existsSync(wtPath)) {
                continue;
            }
        }
        existingSet.add(candidate);
        existingSlugSet.add(candidateSlug);
        result.push(candidate);
    }
    return result;
}

/**
 * Formats a prompt for a Best-of-N candidate agent working in an isolated worktree.
 */
export function formatBestOfNCandidatePrompt(
    taskPrompt: string,
    index: number,
    total: number,
    branchName: string,
    agentLabel?: string
): string {
    const identity = agentLabel ? `${agentLabel} (` : '';
    const identityEnd = agentLabel ? ')' : '';
    const lines = [
        `## Best-of-N Candidate ${index}/${total} (${identity}branch \`${branchName}\`${identityEnd})`,
        '',
        `You are implementing an independent candidate solution in isolated worktree branch \`${branchName}\`.`,
        'Focus on correctness, clean architecture, and passing tests without modifying files outside your worktree.',
        '',
        '### Task',
        taskPrompt.trim(),
        '',
        '### Completion Checklist',
        '1. Implement your solution cleanly and keep unrelated changes out of the diff.',
        '2. Run the relevant build and tests to verify your changes.',
        '3. Summarize your approach, trade-offs, and verified test results concisely.'
    ];
    return lines.join('\n');
}

/**
 * Formats instructions for the Implementer agent in an Implementer + Reviewer duo.
 */
export function formatImplementerPrompt(
    taskPrompt: string,
    branchLabel: string,
    reviewerAgentName: string
): string {
    const lines = [
        `## Implementer Role (\`${branchLabel}\`)`,
        '',
        `You are paired with Reviewer agent \`${reviewerAgentName}\` in the adjacent pane on the same workspace.`,
        '',
        '### Task',
        taskPrompt.trim(),
        '',
        '### Workflow',
        '1. Implement the requested changes cleanly.',
        '2. Run the build/tests and fix any failures.',
        `3. When ready, summarize the changed files and test output so \`${reviewerAgentName}\` can review the diff.`
    ];
    return lines.join('\n');
}

/**
 * Formats instructions for the Reviewer agent paired alongside an Implementer agent.
 */
export function formatReviewerPrompt(
    taskPrompt: string,
    implementerAgentName: string,
    workdir: string,
    branchLabel?: string
): string {
    const branchInfo = branchLabel ? ` (branch \`${branchLabel}\`)` : '';
    const lines = [
        `## Reviewer Role${branchInfo}`,
        '',
        `You are paired as an independent Reviewer for Implementer agent \`${implementerAgentName}\` working in \`${workdir}\`.`,
        'Do NOT edit source files during initial review unless explicitly asked later.',
        '',
        '### Task Under Review',
        taskPrompt.trim(),
        '',
        '### Review Protocol',
        `1. Wait for \`${implementerAgentName}\` to complete its initial edits (inside Herdr you can run \`herdr agent wait ${implementerAgentName}\` / \`herdr agent read ${implementerAgentName} --lines 80\`, or inspect \`git status\` and \`git diff\`).`,
        '2. Review correctness, edge cases, security/safety invariants, and test coverage.',
        '3. Verify whether the build and test suite actually pass.',
        '4. Report prioritized, actionable findings (with exact file/line references) or explicitly approve if no issues remain.'
    ];
    return lines.join('\n');
}

/**
 * Builds an immutable Best-of-N candidate launch plan with unique branches, worktree paths, and agent names.
 */
export function buildBestOfNPlan(options: {
    repoRoot: string;
    baseBranch: string;
    branchPrefix: string;
    existingBranches: string[];
    locationPref: 'sibling' | '.worktrees';
    agents: AgentSlotConfig[];
    taskPrompt: string;
    existingAgentNames?: Set<string>;
}): BestOfNCandidatePlan[] {
    const { repoRoot, branchPrefix, existingBranches, locationPref, agents, taskPrompt, existingAgentNames } = options;
    if (agents.length === 0) {
        return [];
    }

    const usedNames = new Set<string>(existingAgentNames ? Array.from(existingAgentNames) : []);
    const branches = generatePlaybookBranchNames(branchPrefix, agents.length, existingBranches, {
        repoRoot,
        locationPref
    });

    return agents.map((agent, idx) => {
        const index = idx + 1;
        const branchName = branches[idx];
        const worktreePath = resolveWorktreePath(repoRoot, branchName, locationPref);
        const rawAgentSeed = agent.agentKind ? `${branchName}-${agent.agentKind}` : `${branchName}-${index}`;
        const agentName = sanitizeAgentName(rawAgentSeed, usedNames);
        usedNames.add(agentName.toLowerCase());

        return {
            index,
            total: agents.length,
            branchName,
            worktreePath,
            agentName,
            agentCmd: agent.cmd,
            agentKind: agent.agentKind,
            prompt: formatBestOfNCandidatePrompt(taskPrompt, index, agents.length, branchName, agent.label || agent.cmd)
        };
    });
}

/**
 * Builds an immutable Implementer + Reviewer duo launch plan.
 */
export function buildImplementReviewPlan(options: {
    topology: ImplementReviewTopology;
    repoRoot: string;
    branchName?: string;
    baseBranch?: string;
    currentBranch?: string;
    locationPref: 'sibling' | '.worktrees';
    implementer: AgentSlotConfig;
    reviewer: AgentSlotConfig;
    taskPrompt: string;
    existingAgentNames?: Set<string>;
}): ImplementReviewPlan {
    const {
        topology,
        repoRoot,
        branchName,
        baseBranch,
        currentBranch,
        locationPref,
        implementer,
        reviewer,
        taskPrompt,
        existingAgentNames
    } = options;

    const usedNames = new Set<string>(existingAgentNames ? Array.from(existingAgentNames) : []);

    let worktreePath = repoRoot;
    let workspaceLabel = path.basename(repoRoot);
    let normalizedBranch = branchName ? branchName.trim() : undefined;

    if (topology === 'new-worktree') {
        if (!normalizedBranch) {
            throw new Error(l10n.t('Branch name cannot be empty'));
        }
        const branchErr = validateBranchName(normalizedBranch);
        if (branchErr) {
            throw new Error(branchErr);
        }
        worktreePath = resolveWorktreePath(repoRoot, normalizedBranch, locationPref);
        workspaceLabel = normalizedBranch;
    } else {
        normalizedBranch = currentBranch || undefined;
        workspaceLabel = normalizedBranch ? `${path.basename(repoRoot)} (${normalizedBranch})` : path.basename(repoRoot);
    }

    const implSeed = normalizedBranch ? `impl-${normalizedBranch}` : 'implementer';
    const implName = sanitizeAgentName(implSeed, usedNames);
    usedNames.add(implName.toLowerCase());

    const revSeed = normalizedBranch ? `review-${normalizedBranch}` : 'reviewer';
    const revName = sanitizeAgentName(revSeed, usedNames);
    usedNames.add(revName.toLowerCase());

    const branchLabel = normalizedBranch || workspaceLabel;

    return {
        topology,
        branchName: normalizedBranch,
        baseBranch,
        worktreePath,
        workspaceLabel,
        taskPrompt: taskPrompt.trim(),
        implementer: {
            agentName: implName,
            agentCmd: implementer.cmd,
            agentKind: implementer.agentKind,
            prompt: formatImplementerPrompt(taskPrompt, branchLabel, revName)
        },
        reviewer: {
            agentName: revName,
            agentCmd: reviewer.cmd,
            agentKind: reviewer.agentKind,
            prompt: formatReviewerPrompt(taskPrompt, implName, worktreePath, branchLabel)
        }
    };
}

function ensureWorktreesDirIfNeeded(repoRoot: string, locationPref: 'sibling' | '.worktrees'): void {
    if (locationPref !== '.worktrees') {
        return;
    }
    const worktreesDir = path.join(repoRoot, '.worktrees');
    if (!fs.existsSync(worktreesDir)) {
        fs.mkdirSync(worktreesDir, { recursive: true });
    }
}

async function startPlaybookRole(params: {
    role: string;
    sessionName: string;
    paneId: string;
    workspaceId?: string;
    branchName?: string;
    worktreePath: string;
    agentName: string;
    agentCmd: string;
    agentKind?: string;
    prompt: string;
    socketClient?: HerdrSocketClient;
    startAgentFn: (options: StartAgentInPaneOptions) => Promise<StartAgentInPaneResult>;
    launched: PlaybookAgentLaunchOutcome[];
    failures: PlaybookAgentLaunchOutcome[];
}): Promise<void> {
    const {
        role,
        sessionName,
        paneId,
        workspaceId,
        branchName,
        worktreePath,
        agentName,
        agentCmd,
        agentKind,
        prompt,
        socketClient,
        startAgentFn,
        launched,
        failures
    } = params;

    try {
        const res = await startAgentFn({
            sessionName,
            paneId,
            agentName,
            agentCmd,
            agentKind,
            prompt,
            cwd: worktreePath,
            socketClient
        });
        const outcome: PlaybookAgentLaunchOutcome = {
            role,
            agentName,
            branchName,
            worktreePath,
            workspaceId,
            paneId,
            started: res.started,
            prompted: res.prompted,
            ...(res.started ? {} : { error: `Failed to start agent command '${agentCmd}'` })
        };
        if (res.started) {
            launched.push(outcome);
        } else {
            failures.push(outcome);
        }
    } catch (err: any) {
        failures.push({
            role,
            agentName,
            branchName,
            worktreePath,
            workspaceId,
            paneId,
            started: false,
            prompted: false,
            error: err?.message || String(err)
        });
    }
}

/**
 * Executes a Best-of-N playbook: provisions N isolated worktrees, creates Herdr workspaces, and starts N agents.
 */
export async function executeBestOfNPlaybook(options: {
    sessionName: string;
    repoRoot: string;
    baseBranch: string;
    locationPref: 'sibling' | '.worktrees';
    candidates: BestOfNCandidatePlan[];
    socketClient?: HerdrSocketClient;
    progress?: vscodeTypes.Progress<{ message?: string }>;
    bootstrapOptions?: WorktreeBootstrapOptions;
    deps?: PlaybookExecutionDeps;
}): Promise<PlaybookLaunchResult> {
    const {
        sessionName,
        repoRoot,
        baseBranch,
        locationPref,
        candidates,
        socketClient,
        progress,
        bootstrapOptions,
        deps = {}
    } = options;

    const createWt = deps.createWorktreeFn || createWorktree;
    const bootstrapWt = deps.bootstrapWorktreeFn || bootstrapWorktreeEnvironment;
    const createWs = deps.createHerdrWorkspaceFn || createHerdrWorkspace;
    const startAgent = deps.startAgentInPaneFn || startAgentInPane;
    const resolvedBootstrapOpts = bootstrapOptions ?? getWorktreeBootstrapOptions();
    const shouldBootstrap =
        Boolean(deps.bootstrapWorktreeFn) ||
        Boolean(resolvedBootstrapOpts.copyFiles && resolvedBootstrapOpts.copyFiles.length > 0) ||
        Boolean(resolvedBootstrapOpts.postCreateCommand && resolvedBootstrapOpts.postCreateCommand.trim());

    ensureWorktreesDirIfNeeded(repoRoot, locationPref);

    const launched: PlaybookAgentLaunchOutcome[] = [];
    const failures: PlaybookAgentLaunchOutcome[] = [];
    const warnings: string[] = [];
    let fallbackWorkspaceId: string | undefined;
    let fallbackWorktreePath: string | undefined;

    for (const cand of candidates) {
        progress?.report({
            message: l10n.t('Launching candidate {0}/{1} ({2})...', cand.index, cand.total, cand.branchName)
        });

        try {
            await createWt(repoRoot, cand.branchName, cand.worktreePath, baseBranch);
            if (shouldBootstrap) {
                progress?.report({ message: l10n.t('Bootstrapping worktree environment...') });
                const bootRes = await bootstrapWt(repoRoot, cand.worktreePath, resolvedBootstrapOpts);
                if (bootRes.warnings.length > 0) {
                    warnings.push(...bootRes.warnings);
                }
            }
            const ws = await createWs({
                sessionName,
                cwd: cand.worktreePath,
                label: cand.branchName,
                focus: cand.index === 1,
                socketClient
            });

            if (!fallbackWorkspaceId && ws.workspaceId) {
                fallbackWorkspaceId = ws.workspaceId;
            }
            if (!fallbackWorktreePath) {
                fallbackWorktreePath = cand.worktreePath;
            }

            if (!ws.rootPaneId) {
                const outcome: PlaybookAgentLaunchOutcome = {
                    role: `candidate-${cand.index}`,
                    agentName: cand.agentName,
                    branchName: cand.branchName,
                    worktreePath: cand.worktreePath,
                    workspaceId: ws.workspaceId,
                    started: false,
                    prompted: false,
                    error: 'Initial workspace pane could not be resolved'
                };
                failures.push(outcome);
                continue;
            }

            await startPlaybookRole({
                role: `candidate-${cand.index}`,
                sessionName,
                paneId: ws.rootPaneId,
                workspaceId: ws.workspaceId,
                branchName: cand.branchName,
                worktreePath: cand.worktreePath,
                agentName: cand.agentName,
                agentCmd: cand.agentCmd,
                agentKind: cand.agentKind,
                prompt: cand.prompt,
                socketClient,
                startAgentFn: startAgent,
                launched,
                failures
            });
        } catch (err: any) {
            failures.push({
                role: `candidate-${cand.index}`,
                agentName: cand.agentName,
                branchName: cand.branchName,
                worktreePath: cand.worktreePath,
                started: false,
                prompted: false,
                error: err?.message || String(err)
            });
        }
    }

    return {
        playbook: 'best-of-n',
        launched,
        failures,
        primaryWorkspaceId: launched[0]?.workspaceId || fallbackWorkspaceId,
        primaryWorktreePath: launched[0]?.worktreePath || fallbackWorktreePath,
        ...(warnings.length > 0 ? { warnings } : {})
    };
}

/**
 * Executes an Implementer + Reviewer duo playbook with side-by-side split panes in a shared directory.
 */
export async function executeImplementReviewPlaybook(options: {
    sessionName: string;
    repoRoot: string;
    locationPref: 'sibling' | '.worktrees';
    plan: ImplementReviewPlan;
    socketClient?: HerdrSocketClient;
    progress?: vscodeTypes.Progress<{ message?: string }>;
    bootstrapOptions?: WorktreeBootstrapOptions;
    deps?: PlaybookExecutionDeps;
}): Promise<PlaybookLaunchResult> {
    const {
        sessionName,
        repoRoot,
        locationPref,
        plan,
        socketClient,
        progress,
        bootstrapOptions,
        deps = {}
    } = options;

    const createWt = deps.createWorktreeFn || createWorktree;
    const bootstrapWt = deps.bootstrapWorktreeFn || bootstrapWorktreeEnvironment;
    const createWs = deps.createHerdrWorkspaceFn || createHerdrWorkspace;
    const splitPane = deps.splitHerdrPaneFn || splitHerdrPane;
    const startAgent = deps.startAgentInPaneFn || startAgentInPane;
    const resolvedBootstrapOpts = bootstrapOptions ?? getWorktreeBootstrapOptions();
    const shouldBootstrap =
        Boolean(deps.bootstrapWorktreeFn) ||
        Boolean(resolvedBootstrapOpts.copyFiles && resolvedBootstrapOpts.copyFiles.length > 0) ||
        Boolean(resolvedBootstrapOpts.postCreateCommand && resolvedBootstrapOpts.postCreateCommand.trim());

    const launched: PlaybookAgentLaunchOutcome[] = [];
    const failures: PlaybookAgentLaunchOutcome[] = [];
    const warnings: string[] = [];

    let ws: CreateHerdrWorkspaceResult;
    try {
        if (plan.topology === 'new-worktree' && plan.branchName) {
            ensureWorktreesDirIfNeeded(repoRoot, locationPref);
            progress?.report({ message: l10n.t('Creating Git Worktree...') });
            await createWt(repoRoot, plan.branchName, plan.worktreePath, plan.baseBranch);
            if (shouldBootstrap) {
                progress?.report({ message: l10n.t('Bootstrapping worktree environment...') });
                const bootRes = await bootstrapWt(repoRoot, plan.worktreePath, resolvedBootstrapOpts);
                if (bootRes.warnings.length > 0) {
                    warnings.push(...bootRes.warnings);
                }
            }
        }

        progress?.report({ message: l10n.t('Creating Herdr Workspace & Split Panes...') });
        ws = await createWs({
            sessionName,
            cwd: plan.worktreePath,
            label: plan.workspaceLabel,
            focus: true,
            socketClient
        });
    } catch (err: any) {
        return {
            playbook: 'implement-review',
            launched: [],
            failures: [
                {
                    role: 'implementer',
                    agentName: plan.implementer.agentName,
                    branchName: plan.branchName,
                    worktreePath: plan.worktreePath,
                    started: false,
                    prompted: false,
                    error: err?.message || String(err)
                }
            ],
            primaryWorktreePath: plan.worktreePath,
            ...(warnings.length > 0 ? { warnings } : {})
        };
    }

    if (!ws.rootPaneId) {
        const errOutcome: PlaybookAgentLaunchOutcome = {
            role: 'implementer',
            agentName: plan.implementer.agentName,
            branchName: plan.branchName,
            worktreePath: plan.worktreePath,
            workspaceId: ws.workspaceId,
            started: false,
            prompted: false,
            error: 'Initial workspace pane could not be resolved'
        };
        return {
            playbook: 'implement-review',
            launched: [],
            failures: [errOutcome],
            primaryWorkspaceId: ws.workspaceId,
            primaryWorktreePath: plan.worktreePath,
            ...(warnings.length > 0 ? { warnings } : {})
        };
    }

    let reviewPaneId = '';
    try {
        reviewPaneId = await splitPane({
            sessionName,
            direction: 'right',
            targetPaneId: ws.rootPaneId,
            workspaceId: ws.workspaceId,
            cwd: plan.worktreePath,
            focus: false,
            socketClient
        });
    } catch (err: any) {
        failures.push({
            role: 'reviewer',
            agentName: plan.reviewer.agentName,
            branchName: plan.branchName,
            worktreePath: plan.worktreePath,
            workspaceId: ws.workspaceId,
            started: false,
            prompted: false,
            error: err?.message || String(err)
        });
    }

    progress?.report({ message: l10n.t('Starting Implementer ({0})...', plan.implementer.agentCmd) });
    await startPlaybookRole({
        role: 'implementer',
        sessionName,
        paneId: ws.rootPaneId,
        workspaceId: ws.workspaceId,
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
        agentName: plan.implementer.agentName,
        agentCmd: plan.implementer.agentCmd,
        agentKind: plan.implementer.agentKind,
        prompt: plan.implementer.prompt,
        socketClient,
        startAgentFn: startAgent,
        launched,
        failures
    });

    if (reviewPaneId) {
        progress?.report({ message: l10n.t('Starting Reviewer ({0})...', plan.reviewer.agentCmd) });
        await startPlaybookRole({
            role: 'reviewer',
            sessionName,
            paneId: reviewPaneId,
            workspaceId: ws.workspaceId,
            branchName: plan.branchName,
            worktreePath: plan.worktreePath,
            agentName: plan.reviewer.agentName,
            agentCmd: plan.reviewer.agentCmd,
            agentKind: plan.reviewer.agentKind,
            prompt: plan.reviewer.prompt,
            socketClient,
            startAgentFn: startAgent,
            launched,
            failures
        });
    } else if (!failures.some(f => f.role === 'reviewer')) {
        failures.push({
            role: 'reviewer',
            agentName: plan.reviewer.agentName,
            branchName: plan.branchName,
            worktreePath: plan.worktreePath,
            workspaceId: ws.workspaceId,
            started: false,
            prompted: false,
            error: 'Split pane ID could not be resolved'
        });
    }

    return {
        playbook: 'implement-review',
        launched,
        failures,
        primaryWorkspaceId: ws.workspaceId,
        primaryWorktreePath: plan.worktreePath,
        ...(warnings.length > 0 ? { warnings } : {})
    };
}

async function pickAgentSlot(
    title: string,
    placeHolder: string,
    agentOptions: AgentOptionItem[],
    integrations: ParsedIntegrationInfo[],
    checkedTargets: Set<string>,
    socketClient?: HerdrSocketClient
): Promise<AgentSlotConfig | undefined> {
    const selected = await vscode.window.showQuickPick(agentOptions, { title, placeHolder });
    if (!selected) {
        return undefined;
    }

    if (selected.cmd === 'CUSTOM') {
        const customCmd = await vscode.window.showInputBox({
            title: l10n.t('Custom Agent Command'),
            prompt: l10n.t('Enter command to run inside the worktree workspace'),
            placeHolder: l10n.t('e.g. claude --dangerously-skip-permissions')
        });
        if (!customCmd || !customCmd.trim()) {
            return undefined;
        }
        return { label: customCmd.trim(), cmd: customCmd.trim() };
    }

    if (!selected.cmd) {
        vscode.window.showWarningMessage(l10n.t('Please select an AI agent CLI for this playbook role.'));
        return undefined;
    }

    const targetKey = selected.integrationTarget || selected.cmd;
    if (!checkedTargets.has(targetKey)) {
        const ready = await ensureAgentIntegrationReady(selected, socketClient, integrations);
        if (ready === 'cancel') {
            return undefined;
        }
        checkedTargets.add(targetKey);
    }

    return {
        label: selected.description || selected.cmd,
        cmd: selected.cmd,
        agentKind: selected.agentKind
    };
}

async function pickBaseBranch(repoRoot: string): Promise<{ currentBranch: string; branches: string[]; baseBranch: string } | undefined> {
    const branches = await listGitBranches(repoRoot);
    const currentBranch = await getCurrentGitBranch(repoRoot);
    const sorted = Array.from(new Set([currentBranch, 'main', 'master', ...branches])).filter(b => branches.includes(b));
    const items = (sorted.length > 0 ? sorted : [currentBranch]).map(b => ({
        label: `$(git-branch) ${b}`,
        description: b === currentBranch ? l10n.t('(current branch)') : '',
        branchName: b
    }));

    const selectedBase = await vscode.window.showQuickPick(items, {
        title: l10n.t('Herdr Swarm: Base Branch'),
        placeHolder: l10n.t('Select base branch to branch from (default: {0})', currentBranch)
    });
    if (!selectedBase) {
        return undefined;
    }

    return { currentBranch, branches, baseBranch: selectedBase.branchName };
}

/**
 * Interactive wizard for launching multi-agent Swarm Playbooks (`Best-of-N` or `Implementer + Reviewer`).
 */
export async function launchSwarmPlaybookWizard(
    sessionName: string,
    onSuccess?: () => void,
    socketClient?: HerdrSocketClient
): Promise<void> {
    if (!vscode) return;
    if (!(await ensureWorkspaceTrustedForAction(vscode))) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(l10n.t('Please open a folder inside a Git repository first.'));
        return;
    }

    const activeDocUri = vscode.window.activeTextEditor?.document?.uri;
    let repoRoot: string | null = activeDocUri?.scheme === 'file' && activeDocUri.fsPath
        ? await resolveMainRepoRootFromPath(path.dirname(activeDocUri.fsPath))
        : null;
    if (!repoRoot) {
        for (const folder of workspaceFolders) {
            repoRoot = await resolveMainRepoRootFromPath(folder.uri.fsPath);
            if (repoRoot) break;
        }
    }
    if (!repoRoot) {
        vscode.window.showErrorMessage(l10n.t('The current workspace is not a Git repository.'));
        return;
    }

    const playbookPick = await vscode.window.showQuickPick(
        [
            {
                label: `$(versions) ${l10n.t('Best-of-N Parallel Candidates')}`,
                description: l10n.t('N isolated Git worktrees competing on the same task'),
                detail: l10n.t('Launch 2-4 parallel agents (same or diverse CLIs) and compare their diffs side-by-side'),
                playbook: 'best-of-n' as PlaybookKind
            },
            {
                label: `$(organization) ${l10n.t('Implementer + Reviewer Duo')}`,
                description: l10n.t('Paired Implementer and Reviewer in side-by-side panes'),
                detail: l10n.t('Launch an Implementer agent alongside an independent Reviewer inspecting live changes'),
                playbook: 'implement-review' as PlaybookKind
            }
        ],
        {
            title: l10n.t('Herdr Swarm Playbooks'),
            placeHolder: l10n.t('Select a multi-agent orchestration playbook to launch')
        }
    );
    if (!playbookPick) return;

    const config = vscode.workspace.getConfiguration('herdr-collie');
    const locationPref = config.get<'sibling' | '.worktrees'>('worktreeLocation', 'sibling');
    const integrations = await fetchIntegrationStatuses(socketClient).catch(() => [] as ParsedIntegrationInfo[]);
    const allAgentOptions = (await getInstalledAgentOptions(socketClient, integrations)).filter(o => o.cmd !== '');
    const checkedTargets = new Set<string>();
    const existingAgentNames = await collectExistingAgentNames(socketClient);

    if (playbookPick.playbook === 'best-of-n') {
        await runBestOfNWizard(
            sessionName,
            repoRoot,
            locationPref,
            allAgentOptions,
            integrations,
            checkedTargets,
            existingAgentNames,
            onSuccess,
            socketClient
        );
        return;
    }

    await runImplementReviewWizard(
        sessionName,
        repoRoot,
        locationPref,
        allAgentOptions,
        integrations,
        checkedTargets,
        existingAgentNames,
        onSuccess,
        socketClient
    );
}

async function runBestOfNWizard(
    sessionName: string,
    repoRoot: string,
    locationPref: 'sibling' | '.worktrees',
    agentOptions: AgentOptionItem[],
    integrations: ParsedIntegrationInfo[],
    checkedTargets: Set<string>,
    existingAgentNames: Set<string>,
    onSuccess?: () => void,
    socketClient?: HerdrSocketClient
): Promise<void> {
    const countPick = await vscode.window.showQuickPick(
        [
            { label: l10n.t('{0} Candidates', 2), count: 2, description: l10n.t('Recommended for fast A/B comparison') },
            { label: l10n.t('{0} Candidates', 3), count: 3, description: l10n.t('Good balance of diversity and cost') },
            { label: l10n.t('{0} Candidates', 4), count: 4, description: l10n.t('Maximum parallel exploration') }
        ],
        {
            title: l10n.t('Best-of-N: Candidate Count'),
            placeHolder: l10n.t('Select how many parallel worktree candidates to spawn')
        }
    );
    if (!countPick) return;

    const branchPrefix = await vscode.window.showInputBox({
        title: l10n.t('Best-of-N: Branch Prefix'),
        prompt: l10n.t('Enter a branch prefix (creates {0}-1 .. {0}-{1})', 'prefix', countPick.count),
        value: 'swarm/best',
        validateInput: validatePlaybookBranchPrefix
    });
    if (!branchPrefix) return;

    const baseInfo = await pickBaseBranch(repoRoot);
    if (!baseInfo) return;

    const lineupPick = await vscode.window.showQuickPick(
        [
            {
                label: `$(hubot) ${l10n.t('Same Agent for All Candidates')}`,
                description: l10n.t('Run {0} copies of the same AI CLI', countPick.count),
                mode: 'same' as const
            },
            {
                label: `$(sparkle) ${l10n.t('Different Agent per Candidate')}`,
                description: l10n.t('Choose a specific AI CLI for each of the {0} candidates', countPick.count),
                mode: 'diverse' as const
            }
        ],
        {
            title: l10n.t('Best-of-N: Agent Lineup'),
            placeHolder: l10n.t('Choose how AI agents are assigned across candidates')
        }
    );
    if (!lineupPick) return;

    const agents: AgentSlotConfig[] = [];
    if (lineupPick.mode === 'same') {
        const picked = await pickAgentSlot(
            l10n.t('Best-of-N: Select AI Agent'),
            l10n.t('Select AI Agent CLI to launch in all {0} worktree candidates', countPick.count),
            agentOptions,
            integrations,
            checkedTargets,
            socketClient
        );
        if (!picked) return;
        for (let i = 0; i < countPick.count; i++) {
            agents.push(picked);
        }
    } else {
        for (let i = 1; i <= countPick.count; i++) {
            const picked = await pickAgentSlot(
                l10n.t('Best-of-N: Candidate {0}/{1} Agent', i, countPick.count),
                l10n.t('Select AI Agent CLI for candidate {0}/{1}', i, countPick.count),
                agentOptions,
                integrations,
                checkedTargets,
                socketClient
            );
            if (!picked) return;
            agents.push(picked);
        }
    }

    const taskPrompt = await vscode.window.showInputBox({
        title: l10n.t('Best-of-N: Shared Task Prompt'),
        prompt: l10n.t('Enter the task prompt delivered to all {0} candidates', countPick.count),
        placeHolder: l10n.t('e.g. Refactor token validation to support key rotation with unit tests'),
        validateInput: (val: string) => (!val || !val.trim() ? l10n.t('Task prompt cannot be empty') : null)
    });
    if (!taskPrompt) return;

    const plan = buildBestOfNPlan({
        repoRoot,
        baseBranch: baseInfo.baseBranch,
        branchPrefix,
        existingBranches: baseInfo.branches,
        locationPref,
        agents,
        taskPrompt,
        existingAgentNames
    });

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: l10n.t('Launching Best-of-{0} Swarm Playbook...', plan.length),
            cancellable: false
        },
        async (progress) =>
            await executeBestOfNPlaybook({
                sessionName,
                repoRoot,
                baseBranch: baseInfo.baseBranch,
                locationPref,
                candidates: plan,
                socketClient,
                progress
            })
    );

    onSuccess?.();

    if (result.warnings && result.warnings.length > 0) {
        vscode.window.showWarningMessage(
            l10n.t('Worktree created with setup warnings: {0}', Array.from(new Set(result.warnings)).join('; '))
        );
    }

    if (result.failures.length > 0 && result.launched.length === 0) {
        vscode.window.showErrorMessage(
            l10n.t('Best-of-{0} playbook failed to launch: {1}', plan.length, result.failures[0].error || 'Unknown error')
        );
        return;
    }

    if (result.failures.length > 0) {
        vscode.window.showWarningMessage(
            l10n.t('Launched {0}/{1} Best-of-N candidates ({2} failed).', result.launched.length, plan.length, result.failures.length)
        );
    }

    const compareBtn = l10n.t('Review Candidates');
    const radarBtn = l10n.t('Open Conflict Radar');
    const attachBtn = l10n.t('Attach Terminal');
    const action = await vscode.window.showInformationMessage(
        l10n.t('Best-of-{0} playbook launched ({1} candidate worktrees active).', plan.length, result.launched.length),
        compareBtn,
        radarBtn,
        attachBtn
    );

    if (action === compareBtn) {
        vscode.commands.executeCommand('herdr-collie.selectReviewTarget');
    } else if (action === radarBtn) {
        vscode.commands.executeCommand('herdr-collie.showConflictRadar');
    } else if (action === attachBtn && result.primaryWorkspaceId) {
        vscode.commands.executeCommand(
            'herdr-collie.attachWorkspace',
            result.primaryWorkspaceId,
            false,
            result.launched[0]?.branchName || plan[0]?.branchName,
            sessionName
        );
    }
}

async function runImplementReviewWizard(
    sessionName: string,
    repoRoot: string,
    locationPref: 'sibling' | '.worktrees',
    agentOptions: AgentOptionItem[],
    integrations: ParsedIntegrationInfo[],
    checkedTargets: Set<string>,
    existingAgentNames: Set<string>,
    onSuccess?: () => void,
    socketClient?: HerdrSocketClient
): Promise<void> {
    const topologyPick = await vscode.window.showQuickPick(
        [
            {
                label: `$(git-branch) ${l10n.t('New Worktree + Split Panes')}`,
                description: l10n.t('Recommended'),
                detail: l10n.t('Creates a new Git worktree with Implementer (left) and Reviewer (right)'),
                topology: 'new-worktree' as ImplementReviewTopology
            },
            {
                label: `$(root-folder) ${l10n.t('Current Workspace + Split Panes')}`,
                description: path.basename(repoRoot),
                detail: l10n.t('Opens side-by-side Implementer and Reviewer panes on the current repository directory'),
                topology: 'current-workspace' as ImplementReviewTopology
            }
        ],
        {
            title: l10n.t('Implementer + Reviewer: Workspace Topology'),
            placeHolder: l10n.t('Choose where the Implementer and Reviewer duo will work')
        }
    );
    if (!topologyPick) return;

    let branchName: string | undefined;
    let baseBranch: string | undefined;
    let currentBranch = await getCurrentGitBranch(repoRoot);

    if (topologyPick.topology === 'new-worktree') {
        branchName = await vscode.window.showInputBox({
            title: l10n.t('Implementer + Reviewer: Branch Name'),
            prompt: l10n.t('Enter a branch name for the paired worktree'),
            placeHolder: l10n.t('e.g. feat/payment-retry'),
            validateInput: validateBranchName
        });
        if (!branchName) return;

        const baseInfo = await pickBaseBranch(repoRoot);
        if (!baseInfo) return;
        baseBranch = baseInfo.baseBranch;
        currentBranch = baseInfo.currentBranch;
    }

    const implementer = await pickAgentSlot(
        l10n.t('Implementer + Reviewer: Select Implementer Agent'),
        l10n.t('Select the AI agent that will write the implementation (left pane)'),
        agentOptions,
        integrations,
        checkedTargets,
        socketClient
    );
    if (!implementer) return;

    const reviewer = await pickAgentSlot(
        l10n.t('Implementer + Reviewer: Select Reviewer Agent'),
        l10n.t('Select the AI agent that will review the changes (right pane)'),
        agentOptions,
        integrations,
        checkedTargets,
        socketClient
    );
    if (!reviewer) return;

    const taskPrompt = await vscode.window.showInputBox({
        title: l10n.t('Implementer + Reviewer: Task Prompt'),
        prompt: l10n.t('Enter the implementation task shared with both agents'),
        placeHolder: l10n.t('e.g. Add rate limiting middleware and verify edge cases'),
        validateInput: (val: string) => (!val || !val.trim() ? l10n.t('Task prompt cannot be empty') : null)
    });
    if (!taskPrompt) return;

    const plan = buildImplementReviewPlan({
        topology: topologyPick.topology,
        repoRoot,
        branchName,
        baseBranch,
        currentBranch,
        locationPref,
        implementer,
        reviewer,
        taskPrompt,
        existingAgentNames
    });

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: l10n.t('Launching Implementer + Reviewer Playbook...'),
            cancellable: false
        },
        async (progress) =>
            await executeImplementReviewPlaybook({
                sessionName,
                repoRoot,
                locationPref,
                plan,
                socketClient,
                progress
            })
    );

    onSuccess?.();

    if (result.warnings && result.warnings.length > 0) {
        vscode.window.showWarningMessage(
            l10n.t('Worktree created with setup warnings: {0}', Array.from(new Set(result.warnings)).join('; '))
        );
    }

    if (result.failures.length > 0 && result.launched.length === 0) {
        vscode.window.showErrorMessage(
            l10n.t('Implementer + Reviewer playbook failed to launch: {0}', result.failures[0].error || 'Unknown error')
        );
        return;
    }

    if (result.failures.length > 0) {
        vscode.window.showWarningMessage(
            l10n.t(
                'Implementer + Reviewer playbook partially started ({0} running, {1} failed).',
                result.launched.length,
                result.failures.length
            )
        );
    }

    const attachBtn = l10n.t('Attach Terminal');
    const openWindowBtn = l10n.t('Open in VS Code Window');
    const buttons = plan.topology === 'new-worktree' ? [attachBtn, openWindowBtn] : [attachBtn];
    const choice = await vscode.window.showInformationMessage(
        l10n.t(
            'Implementer ({0}) + Reviewer ({1}) launched in split panes.',
            plan.implementer.agentName,
            plan.reviewer.agentName
        ),
        ...buttons
    );

    if (choice === attachBtn && result.primaryWorkspaceId) {
        vscode.commands.executeCommand(
            'herdr-collie.attachWorkspace',
            result.primaryWorkspaceId,
            false,
            plan.workspaceLabel,
            sessionName
        );
    } else if (choice === openWindowBtn && plan.worktreePath) {
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(plan.worktreePath), { forceNewWindow: true });
    }
}
