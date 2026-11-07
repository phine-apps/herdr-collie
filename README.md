# Herdr Collie

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/phine-apps.herdr-collie?color=blue&label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=phine-apps.herdr-collie)
[![VS Code Engine](https://img.shields.io/badge/vscode-%5E1.90.0-informational.svg)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![L10n: English | 日本語 | 简体中文](https://img.shields.io/badge/i18n-EN%20%7C%20JA%20%7C%20ZH-success.svg)](package.nls.json)

**Herdr Collie** is a powerful VS Code extension designed to bridge Visual Studio Code with the **Herdr** multi-agent CLI/TUI platform. It orchestrates AI coding swarms inside isolated Git worktrees, delivers real-time situational awareness via an Attention HUD, and closes the development loop with inline code reviews and diff-to-prompt feedback.

Stop context-switching between terminals or manually copying file paths. Supercharge your AI-driven workflow with zero friction.

---

## ⚡ Quick Start in 30 Seconds

1. **Ensure Prerequisites**: Have `herdr` and `git` installed on your system.
2. **Install Agent Integrations**:
   ```bash
   herdr integration install claude            # For Claude Code
   herdr integration install antigravity-cli   # For Antigravity CLI (agy)
   herdr integration install copilot          # For GitHub Copilot CLI
   ```
3. **Launch an Isolated Worktree Agent**: Press `Ctrl+Alt+H L`, choose or type a branch name, pick your agent (`claude`, `agy`, etc.), and input your task.
4. **Monitor from the HUD**: Keep working on your main branch. When the agent needs tool approval or finishes, an interactive notification alerts you (`[Approve (y)]` / `[Quick Reply]`).
5. **Review & Iterate**: Open the **Review Changes** tree, review diffs, leave inline comments (`Ctrl+Alt+H C`), and submit revisions back to the agent (`Ctrl+Alt+H R`).

---

## 🚀 Key Features

### 1. Smart Swarm & Git Worktree Isolation
Parallelize AI agent tasks effortlessly without touching your active working directory or dealing with dirty working trees:
- **One-Click Worktree Provisioning** (`Ctrl+Alt+H L`): Creates an isolated Git worktree on a new or existing branch, configures a dedicated Herdr workspace, launches the specified AI agent (`claude`, `agy`, `cursor-agent`, `copilot`, or custom CLI), and starts execution automatically.
- **Open in New VS Code Window**: Open any Herdr workspace or worktree directory in a brand-new VS Code window with a single click (`$(link-external)`) or command (`herdr-collie.openWorkspaceInNewWindow`).
- **Worktree Sidebar Integration**: Worktrees are automatically tagged with their branch name in the Workspaces view, featuring inline actions to open in a new window, merge (`$(git-merge)`), or safely delete (`$(trash)`).
- **Pre-Merge Verification & Conflict Delegation**: Validates mergeability and uncommitted changes before merging. If merge blockers arise, delegate resolution directly to the worktree agent with a structured prompt.

### 2. Real-Time Attention HUD & Live State Tracking
Maintain full situational awareness across all parallel agents without terminal juggling:
- **Status Bar Live HUD**: Real-time summary on the bottom status bar:
  - `$(sync~spin) N Working`: Indicates active background processing.
  - `$(alert) N Waiting`: Prominently highlights agents waiting for user input or tool execution approval.
  - `$(hubot) N Idle`: Clean overview when all agents are idle.
- **Time-in-State & Live Output Preview**: Tracks elapsed time in current status (`🟢 Working (2m 5s)` / `🔴 Input Needed (45s)`) and previews the latest 1-line output summary across status bar tooltips, HUD menus, and sidebar agent trees.
- **Activity Bar Unread Badge**: The Herdr Collie activity bar icon displays a live badge counter whenever agents require attention.
- **Zero-Context-Switch Approval Notifications**: When an agent requests tool approval (e.g. bash execution, file edits), an interactive notification displays the latest prompt line with action buttons:
  - `[Approve (y)]`: Approves tool execution instantly.
  - `[Deny (n)]`: Denies tool execution.
  - `[Quick Reply...]`: Sends typed guidance directly to the agent.
  - `[Focus Terminal]`: Switches immediately to the agent's interactive terminal pane.
- **Interactive HUD Command Palette** (`Ctrl+Alt+H H`): Opens a QuickPick menu to inspect agents across all sessions, trigger quick actions, or send custom prompts.

### 3. Integrated Visual Review & Diff-to-Prompt (All-or-Nothing Safe Delivery)
Inspect AI-generated code directly within VS Code before merging:
- **Review Changes Sidebar Tree** (`herdr-collie.reviewChanges`): Displays modified, added, and deleted files with flat or hierarchical tree modes.
- **Single-Click Side-by-Side Diff**: Click any changed file to view native editor diffs (`HEAD ↔ Working Tree` or against checkpoints).
- **Inline Review Comments** (`vscode.comments`): Add line-level comments on diffs or active editor documents (`Ctrl+Alt+H C`).
- **All-or-Nothing Safe Delivery (`submitSafely`)**: Never lose your review comments on network or agent delivery errors. Comments remain intact until successfully acknowledged by the agent.
- **Flexible Submission Modes** (`Ctrl+Alt+H R`):
  - **Standard Review**: Dispatches code review comments directly to the agent.
  - **Draft Mode (Stage in Agent Input)**: Pastes the formatted review feedback into the agent's input line without pressing Enter, allowing you to preview or customize before sending.
  - **Copy to Clipboard**: Copies formatted markdown review prompt to clipboard.
  - **Crystallize Rule**: Appends generalizable rules to `AGENTS.md` to prevent recurring mistakes.
- **Automated Checkpoints & One-Click Rollback**: Automatically creates working tree checkpoints prior to reviewing. Roll back changes instantly (`$(history)`) if the agent took an undesired direction.

### 4. Micro-Task CodeLens & Quick-Fix
Delegate targeted tasks to AI agents with zero prompt engineering:
- **Diagnostic Quick-Fix (`Cmd+.` / `Ctrl+.`)**: When compiler errors or linter warnings appear, open the VS Code Quick-Fix menu and select `🛠️ Delegate Fix to Herdr Agent` to send the exact error, file location, and relevant code chunk to an idle agent.
- **Test-Runner CodeLens**: Displays inline action links directly above test suites and test cases (`describe` / `it` / `test`):
  - `▶ Fix Test with Herdr Agent`: Dispatches the test definition and failure context to an agent.
  - `🧪 Generate Edge Cases`: Prompts the agent to write boundary conditions and edge-case unit tests.
- **TODO Completion CodeLens**: Displays `▶ Complete TODO with Herdr Agent` above `// TODO:` or `// FIXME:` comments to auto-delegate pending tasks.
- **Smart Context Dispatch (`Ctrl+Alt+H Enter`)**: Press `Ctrl+Alt+H Enter` anywhere in an active file to automatically inspect cursor context (diagnostics, tests, or TODOs) and dispatch it to the nearest idle agent.

### 5. High-Signal Context Bridge
Send rich development context to your AI agents immediately via shortcuts, context menu, or Command Palette:
- **Send Selection** (`Ctrl+Alt+H S`): Sends selected lines of code with filename, language, and line numbers.
- **Send Symbol Info (Hover)**: Sends full type definitions, function signatures, and JSDoc / hover details of the symbol under the cursor.
- **Send Errors/Warnings** (`Ctrl+Alt+H D`): Sends active file diagnostics.
- **Send Workspace Problems**: Sends project-wide errors and warnings in a single batch (ideal after refactoring).
- **Send Terminal Output / Error**: Sends recent output or selected text from the integrated terminal.

### 6. Git & SCM Integration
Deep integration with VS Code's Source Control (SCM) view:
- **Send Staged Changes**: Sends staged diffs (`git add`) for commit message generation or pre-commit reviews.
- **Send Working Tree Changes**: Sends unstaged working tree diffs.
- **Send Branch Context**: Sends the current branch name and commit history since branching off the base branch.

### 7. Herdr Sessions, Workspaces & Swarm Management
Manage your Herdr environment directly from the **Herdr Sidebar Panel** (organized into **Sessions**, **Workspaces**, **Agents**, and **Review Changes** views):
- **Sessions View**: View active and background Herdr sessions, switch active views with a single click, create new sessions (`+`), or delete custom sessions (`$(trash)`).
- **Workspaces View**: Create, rename, delete, and focus Herdr workspaces, with instant Git Worktree integration and drag-and-drop reordering.
- **Agents View**: Monitor live agents with status indicators (`🟢 Working`, `🟡 Waiting`, `⚪ Idle`, `🔴 Blocked`) and toggle sort order between **Grouped** (by workspace) and **Priority** (Attention Queue urgency) with one click (`$(list-ordered)`).
- **Optimized Terminal UI**: Automatically suppresses Herdr's built-in TUI sidebar in the integrated terminal to avoid redundancy with VS Code's sidebar, maximizing code editing space.

### 8. Multi-Language Support (Internationalization)
Herdr Collie features native localization support across all views, menus, dialogs, and notifications:
- 🇺🇸 **English**
- 🇯🇵 **Japanese (日本語)**
- 🇨🇳 **Simplified Chinese (简体中文)**

Language packs seamlessly follow your VS Code display language setting.

---

## 🤖 Agent Integrations Setup

To enable Herdr Collie to automatically detect AI agents, send prompts directly (`agent prompt`), and monitor their live status (Working 🟢 / Waiting 🟡 / Idle ⚪), **install the corresponding agent integrations in Herdr**:

```bash
# Check current integration installation status
herdr integration status

# Install integrations for each AI agent
herdr integration install claude            # For Claude Code
herdr integration install antigravity-cli   # For Antigravity CLI (agy)
herdr integration install copilot          # For GitHub Copilot CLI
herdr integration install codex            # For Codex CLI
herdr integration install cursor           # For Cursor
```

> [!NOTE]
> Once installed, whenever an AI agent runs inside a Herdr pane, it automatically appears in Collie's "Agents" view and becomes available as a prompt dispatch destination.

---

## ⌨️ Commands & Keyboard Shortcuts

Herdr Collie provides conflict-free 2-stroke chord shortcuts prefixed by `Ctrl + Alt + H`:

| Command Title | Command ID | Shortcut | Description / Context |
| :--- | :--- | :--- | :--- |
| **Smart Context Dispatch** | `herdr-collie.dispatchContextTask` | `Ctrl+Alt+H Enter` | Context-aware dispatch (diagnostics, test, or TODO) |
| **Send Selection** | `herdr-collie.sendContext` | `Ctrl+Alt+H S` | Sends selected code in active editor |
| **Select & Attach Agent** | `herdr-collie.selectAgent` | `Ctrl+Alt+H A` | QuickPick to select an agent & open its terminal |
| **Select & Focus Workspace** | `herdr-collie.selectWorkspace` | `Ctrl+Alt+H W` | QuickPick to select a workspace & open its terminal |
| **Attach to Workspace** | `herdr-collie.attachWorkspace` | `Ctrl+Alt+H T` | Unified target selector (Workspaces, Agents & Sessions) |
| **Send Errors/Warnings** | `herdr-collie.sendDiagnostics` | `Ctrl+Alt+H D` | Sends active file diagnostics to agent |
| **Show Agent HUD** | `herdr-collie.showAgentHUD` | `Ctrl+Alt+H H` | Opens Agent HUD for status check and quick approvals |
| **Launch Agent in Git Worktree** | `herdr-collie.launchWorktreeAgent` | `Ctrl+Alt+H L` | Launches AI agent in an isolated Git worktree |
| **Add Review Comment** | `herdr-collie.addReviewComment` | `Ctrl+Alt+H C` | Adds inline review comment on current line |
| **Submit Review to Agent** | `herdr-collie.submitReview` | `Ctrl+Alt+H R` | Packages diffs & comments and dispatches to agent |
| **Open Workspace in New Window** | `herdr-collie.openWorkspaceInNewWindow` | Inline `$(link-external)` | Opens Herdr workspace / worktree in new VS Code window |
| **Quick-Fix: Fix with Agent** | `herdr-collie.fixDiagnosticWithAgent` | `Cmd+.` / `Ctrl+.` | Delegates diagnostic error to agent via Lightbulb |
| **CodeLens: Fix Test** | `herdr-collie.fixTestWithAgent` | Click CodeLens | Delegates failing test case to agent |
| **CodeLens: Complete TODO** | `herdr-collie.completeTodoWithAgent` | Click CodeLens | Delegates TODO / FIXME task to agent |
| **Open Review Diff** | `herdr-collie.openDiff` | Click item | Opens side-by-side diff in Review Changes tree |
| **Create Review Checkpoint** | `herdr-collie.createReviewCheckpoint` | Title icon | Creates working tree checkpoint |
| **Rollback Review Checkpoint** | `herdr-collie.rollbackReviewCheckpoint` | Title icon | Rolls back working tree to checkpoint |
| **Clear Review Comments** | `herdr-collie.clearReview` | Command Palette | Clears all pending review comments |
| **Send Symbol Info (Hover)** | `herdr-collie.sendHoverInfo` | Context menu | Sends type & signature of symbol under cursor |
| **Send Workspace Problems** | `herdr-collie.sendWorkspaceProblems` | Context menu | Sends all workspace compiler errors/warnings |
| **Send Staged Changes** | `herdr-collie.sendStagedChanges` | SCM menu | Sends staged diffs (`git add`) |
| **Send Working Tree Changes** | `herdr-collie.sendWorkingTreeChanges` | SCM menu | Sends unstaged working tree diffs |
| **Send Branch Context** | `herdr-collie.sendBranchContext` | SCM menu | Sends branch name & commit history |
| **Send Terminal Output** | `herdr-collie.sendTerminalOutput` | Terminal menu | Sends recent output from integrated terminal |
| **Merge Worktree** | `herdr-collie.mergeWorktree` | Inline icon | Merges worktree branch into current branch |
| **Remove Worktree** | `herdr-collie.removeWorktree` | Inline icon | Deletes worktree and closes workspace |

> [!TIP]
> You can customize any keybinding by opening `Preferences: Open Keyboard Shortcuts` (`Cmd + K Cmd + S` / `Ctrl + K Ctrl + S`) and searching for `Herdr Collie`.

---

## ⚙️ Requirements & Configuration

- **Requirements**:
  - Visual Studio Code 1.90.0 or higher
  - Herdr CLI available in your system `PATH`
  - Git CLI installed (for Git Worktree and SCM integration)
  - Agent integration installed via `herdr integration install <target>`

- **Configuration Settings**:
  - `herdr-collie.sessionName` (default: `"vscode"`):
    Session name used when launching Herdr from VS Code's integrated terminal.
  - `herdr-collie.defaultAgentCommand` (default: `"claude"`):
    Default AI agent command used when launching agents in Git worktrees (`"claude"`, `"agy"`, `"cursor-agent"`, `"copilot"`, etc.).
  - `herdr-collie.worktreeLocation` (default: `"sibling"`):
    Directory layout for Git worktrees (`"sibling"` creates `../<repo>-<branch>`, `".worktrees"` creates inside repository).
  - `herdr-collie.agentSortOrder` (default: `"grouped"`):
    Default sort order in the Agents view (`"grouped"` or `"priority"`).
  - `herdr-collie.agentHUD.enableNotifications` (default: `true`):
    Enables native interactive notifications when an agent enters waiting/blocked state.
  - `herdr-collie.codeLens.enable` (default: `true`):
    Enables inline CodeLens action links for test runners and TODO items.
  - `herdr-collie.quickFix.enable` (default: `true`):
    Enables `🛠️ Delegate Fix to Herdr Agent` in VS Code's Quick-Fix lightbulb menu (`Cmd+.`).
  - `herdr-collie.hideHerdrSidebar` (default: `true`):
    Automatically hides Herdr's built-in TUI sidebar in the integrated terminal to maximize screen area.
