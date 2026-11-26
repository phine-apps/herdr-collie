/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { AgentHUD } from '../agentHUD';
import { WorktreeConflictRadar } from '../conflictRadar';
import { HerdrReviewController, HerdrReviewChangesProvider } from '../reviewManager';
import { HerdrSessionProvider, HerdrWorkspaceProvider } from '../sidebarProviders';
import { HerdrSocketClient } from '../socketClient';
import { TerminalShellMonitor } from '../terminalShellManager';
import { HerdrWorkspaceTreeItem } from '../workspaceDragAndDrop';
import { GitWorktreeInfo } from '../parsers';
import { WorktreeScorecard } from '../worktreeManager';

export interface CommandContext {
    getActiveSidebarSession(): string;
    getSocketClient(): HerdrSocketClient;
    refreshAllProviders(options?: { includeHUDs?: boolean; includeSessions?: boolean; snapshotMaxAgeMs?: number }): void;
    updateTreeViewDescriptions(): void;
    openOrAttachTerminal(
        target: string,
        isAgent: boolean,
        displayLabel: string,
        targetSession: string,
        targetWorkspaceId?: string,
        targetTabId?: string
    ): Promise<void>;
    sendToHerdr(
        richText: string,
        successMsg: string,
        quickPickTitle: string,
        options?: { stageOnly?: boolean; preferredCwd?: string; preferredAgentId?: string }
    ): Promise<boolean>;
    switchToSession(targetSession: string): Promise<void>;
    performDeleteSession(sessionToDelete: string): Promise<void>;
    getActiveRepoRoot(): Promise<string | null>;
    resolveMainRepoRoot(hintPath?: string): Promise<string | null>;
    loadWorktreeScorecards(repoRoot: string, candidates: GitWorktreeInfo[]): Promise<Map<string, WorktreeScorecard>>;
    activateWorktreeReviewTarget(repoRoot: string, worktreePath: string, branchName?: string, labelHint?: string): Promise<void>;
    getAgentItems(): HerdrWorkspaceTreeItem[];
    sessionProvider: HerdrSessionProvider;
    agentProvider: HerdrWorkspaceProvider;
    agentHUD: AgentHUD;
    reviewController: HerdrReviewController;
    reviewChangesProvider: HerdrReviewChangesProvider;
    terminalShellMonitor: TerminalShellMonitor;
    getConflictRadar(): WorktreeConflictRadar | undefined;
}
