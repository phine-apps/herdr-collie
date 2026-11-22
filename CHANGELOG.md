# Changelog

All notable changes to **Herdr Collie** will be documented in this file.

## [0.1.0] - Initial Release

### Added
- **Smart Swarm & Git Worktree Isolation**:
  - One-click isolated Git worktree provisioning and AI agent launch (`Ctrl+Alt+H L`), with optional GitHub Issue integration via `gh` CLI.
  - Worktree bootstrap automation: copies configured untracked files (`herdr-collie.worktree.copyFiles`, e.g., `.env*`) and optionally runs `herdr-collie.worktree.postCreateCommand`.
  - Worktree comparison scorecards showing diff stats, mergeability, and LSP error counts.
  - Pre-merge conflict/uncommitted verification with structured agent delegation, local merge, and Pull Request creation / failing PR check dispatch (`gh`).
- **Multi-Agent Swarm Playbooks**:
  - **Best-of-N Parallel Candidates**: Spawn 2–4 isolated worktrees with identical or diverse AI CLIs on the same task.
  - **Implementer + Reviewer Duo**: Launch paired Implementer and Reviewer agents in side-by-side split panes.
- **Parallel Worktree Conflict Radar**:
  - Automatic scanning across Git worktrees for overlapping file edits with Explorer file decorations, StatusBar alerts, side-by-side worktree file diffs, and agent coordination prompts.
- **Real-Time Attention HUD & Workspace HUD**:
  - Live StatusBar summaries for active agents (`Working`, `Waiting`, `Idle`), elapsed time-in-state, latest output preview, and active Herdr workspace/branch indicator.
  - Interactive approval notifications (`Approve (y)`, `Deny (n)`, `Quick Reply...`, `Focus Terminal`) and closed-loop post-completion diagnostic verification (`herdr-collie.agentHUD.autoVerifyDiagnostics`).
  - Activity Bar badge for agents awaiting user confirmation.
- **Integrated Visual Review & Diff-to-Prompt**:
  - **Review Changes** sidebar tree (`tree` / `flat` view modes) supporting both the current workspace and cross-worktree review targets against merge-base.
  - Native inline review comments (`Ctrl+Alt+H C`), All-or-Nothing safe delivery (`Ctrl+Alt+H R`), Draft Mode staging, Clipboard export, and `AGENTS.md` rule crystallization.
  - Automated Git review checkpoints and one-click rollback preserving pre-existing untracked files.
- **Micro-Task CodeLens, Quick-Fix & Terminal Shell Integration**:
  - Lightbulb Quick-Fix (`Delegate Fix to Herdr Agent`), Test-Runner & TODO CodeLens actions, and Smart Context Dispatch (`Ctrl+Alt+H Enter`).
  - Terminal Shell Integration monitor capturing failed command outputs with QuickFix notifications and `Ctrl+Alt+H F`.
- **High-Signal Context Bridge & Herdr Sidebar**:
  - Send editor selections (`Ctrl+Alt+H S`), diagnostics (`Ctrl+Alt+H D`), workspace problems, symbol hover info, SCM diffs, branch history, and terminal outputs.
  - Dedicated **Sessions**, **Workspaces** (drag-and-drop reordering, tab hierarchy, open in new window), **Agents** (Grouped / Priority sorting, live output peek), and **Review Changes** views, plus GUI Agent Integrations manager.
  - Auto-hidden Herdr TUI sidebar configuration sync and terminal auto-restore across restarts.
- **Internationalization (l10n)**:
  - Native localization for English, Japanese (`ja`), and Simplified Chinese (`zh-cn`).
