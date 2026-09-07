# Herdr Collie

Herdr Collie is a VS Code extension designed to seamlessly integrate VS Code with the powerful AI agent platform **Herdr**.
Send the exact context you are looking at in your editor (code, errors, Git diffs, and more) to Herdr agents with a single click, supercharging your AI-driven development workflow.

## 🚀 Key Features

### 1. Smart Swarm & Git Worktree Launcher
Parallelize AI agent tasks effortlessly without touching your main working directory:
- **Launch Agent in Git Worktree** (`Alt+H L` / `Option+H L`): Creates an isolated Git worktree on a new/existing branch, provisions a Herdr workspace, launches the specified AI agent (`claude`, `agy`, `cursor-agent`, `copilot`, or custom), and dispatches the task prompt in one seamless flow.
- **Worktree Sidebar Integration**: Worktrees are automatically badged with their branch name in the Workspaces view with a Git branch icon and quick inline actions to merge (`$(git-merge)`) or delete (`$(trash)`).
- **Merge & Cleanup**: Merge changes back to your active branch with one click upon completion.

### 2. Agent Attention HUD & Quick-Action Notifications
Keep full situational awareness with zero context switching:
- **Show Agent HUD** (`Alt+H H` / `Option+H H`): Opens interactive HUD menu to monitor all agents across sessions and approve pending confirmations in one place.
- **Status Bar Live HUD**: Real-time summary on the bottom status bar:
  - `$(sync~spin) N Working`: Indicates active background processing.
  - `$(alert) N Waiting`: Highlights agents requiring user approval or confirmation.
  - `$(hubot) N Idle`: Clean idle overview.
- **Interactive Approval Notifications**: When an agent transitions to waiting/blocked for confirmation (e.g. tool execution permission), a native notification pops up with interactive buttons:
  - `[Approve (y)]`: Approves instantly without opening the terminal.
  - `[Deny (n)]`: Denies tool execution.
  - `[Quick Reply...]`: Opens an input box to send quick instructions.
  - `[Focus Terminal]`: Jumps straight to the agent's interactive terminal pane.

### 3. Herdr Sessions, Workspaces & Agents Management
Manage your Herdr environment directly from the **Herdr Sidebar Panel** (organized in 3 dedicated views: **Sessions**, **Workspaces**, and **Agents**) or via fast keyboard selectors:
- **Sessions View**: View active and background Herdr sessions, switch active views with a single click, create new sessions (`+`), or delete custom sessions (`$(trash)`).
- **Workspaces View**: Create, rename, delete, and focus Herdr workspaces, with instant Git Worktree integration.
- **Agents View**: Monitor live agents with status indicators (`🟢 Working`, `🟡 Waiting`, `⚪ Idle`, `🔴 Blocked`) and toggle sort order between **Grouped** (by workspace) and **Priority** (Attention Queue urgency) with one click (`$(list-ordered)`).
- **Select & Attach Agent** (`Alt+H A` / `Option+H A`): Fast QuickPick listing all active agents with live status and worktree branch badges.
- **Select & Focus Workspace** (`Alt+H W` / `Option+H W`): Fast QuickPick to focus a workspace and open/focus its Herdr terminal.
- **Attach Target** (`Alt+H T` / `Option+H T`): Unified selector across all workspaces, agents, and sessions.
- **Optimized Terminal UI**: When launching Herdr inside VS Code's integrated terminal, the standard Herdr TUI sidebar is automatically hidden (collapsed to 0 width) to avoid redundancy with the VS Code Herdr Collie sidebar, maximizing screen real estate.

### 4. Context Sharing
Send high-signal development contexts to your AI agents immediately via shortcuts, context menu, or Command Palette:
- **Send Selection** (`Alt+H S` / `Option+H S`): Sends the currently selected lines of code with filename, language, and line numbers.
- **Send Symbol Info (Hover)**: Sends full type definitions, function signatures, and JSDoc / hover details of the symbol under the cursor.

### 5. Error & Warning Analysis (Diagnostics)
Easily forward compiler errors and diagnostics detected by language servers to AI agents for instant fixes:
- **Send Errors/Warnings** (`Alt+H D` / `Option+H D`): Sends diagnostics (errors and warnings) in the currently active file.
- **Send Workspace Problems**: Sends all project-wide errors and warnings in a single batch (ideal for asking AI to fix issues after large refactorings or build failures).

### 6. Git & SCM Integration
Deep integration with the Source Control (SCM) view allows you to provide Git diffs and branch history as AI context:
- **Send Staged Changes**: Sends diffs of staged changes (`git add`). Perfect for generating commit messages or requesting pre-commit reviews.
- **Send Working Tree Changes**: Sends unstaged working tree diffs.
- **Send Branch Context**: Sends the current branch name along with the commit log since branching off from the base branch (helpful for generating PR summaries).

### 7. Terminal Output & Error Sharing
Send build errors and test failure logs straight to your agents:
- **Send Terminal Output / Error**: Sends recent output (or selected text) from the active integrated terminal via the terminal context menu or Command Palette.

## 🤖 Agent Integrations Setup

To enable Herdr Collie to automatically detect AI agents like Claude Code or Antigravity, send prompts directly (`agent prompt`), and monitor their live status (Working 🟢 / Idle 🟡), **the corresponding agent integrations (hooks) must be installed in Herdr**.

Run the following commands in your terminal to enable integrations for the AI tools you use:

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
> Once installed, whenever the corresponding AI agent runs inside a pane, it will automatically appear in Collie's "Agents" view and be available as a context destination.

## ⌨️ Commands & Keyboard Shortcuts

Herdr Collie provides conflict-free 2-stroke chord shortcuts prefixed by `Alt + H` (macOS: `Option + H`):

| Command Title | Command ID | Shortcut (`macOS` / `Win·Linux`) | Description / Menu Locations |
| :--- | :--- | :--- | :--- |
| **Send Selection** | `herdr-collie.sendContext` | `Option+H S` / `Alt+H S` | Sends selected code in active editor (`editorTextFocus`) |
| **Select & Attach Agent** | `herdr-collie.selectAgent` | `Option+H A` / `Alt+H A` | QuickPick to select an agent & open/focus its terminal |
| **Select & Focus Workspace** | `herdr-collie.selectWorkspace` | `Option+H W` / `Alt+H W` | QuickPick to select a workspace & open/focus its terminal |
| **Attach to Workspace** | `herdr-collie.attachWorkspace` | `Option+H T` / `Alt+H T` | Unified target selector (Workspaces, Agents & Sessions) |
| **Send Errors/Warnings** | `herdr-collie.sendDiagnostics` | `Option+H D` / `Alt+H D` | Sends active file diagnostics (`editorTextFocus`) |
| **Show Agent HUD** | `herdr-collie.showAgentHUD` | `Option+H H` / `Alt+H H` | Opens Agent HUD for status check and quick approvals |
| **Launch Agent in Git Worktree** | `herdr-collie.launchWorktreeAgent` | `Option+H L` / `Alt+H L` | Launches AI agent in an isolated Git worktree |
| **Send Symbol Info (Hover)** | `herdr-collie.sendHoverInfo` | — | Editor context menu (`editorFocus`) / Command Palette |
| **Send Workspace Problems** | `herdr-collie.sendWorkspaceProblems` | — | Editor context menu / Command Palette |
| **Send Staged Changes** | `herdr-collie.sendStagedChanges` | — | SCM title & item menu / Editor context menu |
| **Send Working Tree Changes** | `herdr-collie.sendWorkingTreeChanges` | — | SCM title & item menu / Editor context menu |
| **Send Branch Context** | `herdr-collie.sendBranchContext` | — | SCM title menu / Editor context menu |
| **Send Terminal Output / Error** | `herdr-collie.sendTerminalOutput` | — | Terminal context menu (`terminalIsOpen`) |
| **Merge Worktree Changes** | `herdr-collie.mergeWorktree` | — | Worktree item context menu / Command Palette |
| **Remove Worktree & Workspace** | `herdr-collie.removeWorktree` | — | Worktree item context menu / Command Palette |
| **Switch Session** | `herdr-collie.switchSession` | — | Sessions view click / Command Palette |
| **Create Session** | `herdr-collie.createSession` | — | Sessions view title menu (`+`) / Command Palette |
| **Refresh Sessions** | `herdr-collie.refreshSessions` | — | Sessions view title menu (`$(refresh)`) |
| **Delete Session** | `herdr-collie.deleteSession` | — | Sessions view item inline menu (`$(trash)`) |
| **Toggle Agent Sort Order** | `herdr-collie.toggleAgentSort` | — | Agents view title menu (`$(list-ordered)`) |
| **Create Workspace** | `herdr-collie.createWorkspace` | — | Workspaces view title menu (`+`) |
| **Rename Workspace** | `herdr-collie.renameWorkspace` | — | Workspace item context menu |
| **Close Workspace** | `herdr-collie.closeWorkspace` | — | Workspace item context menu |
| **Refresh Workspaces** | `herdr-collie.refreshWorkspaces` | — | Workspaces & Agents view title menu (`$(refresh)`) |

> [!TIP]
> You can easily customize any keybinding by opening `Preferences: Open Keyboard Shortcuts` (`Cmd + K Cmd + S` / `Ctrl + K Ctrl + S`) and searching for `Herdr Collie`.

## ⚙️ Requirements & Configuration

- **Requirements**:
  - Visual Studio Code 1.90.0 or higher
  - Herdr CLI available in your system `PATH`
  - Git CLI installed (if using Git integration features)
  - Integration installed via `herdr integration install <target>` (if using AI agent integrations)

- **Configuration Settings**:
  - `herdr-collie.sessionName` (default: `"vscode"`):
    Session name used when launching Herdr from VS Code's integrated terminal. Using a dedicated session name (e.g. `vscode`) ensures your VS Code workspace runs independently without interfering with standard sessions (such as `default`) running in external terminals like iTerm2.
  - `herdr-collie.agentSortOrder` (default: `"grouped"`):
    Default sort order for active agents in the Agents sidebar view: `"grouped"` (grouped by workspace) or `"priority"` (Attention Queue ordered by urgency: Blocked 🔴 ➔ Working 🟢 ➔ Idle 🟡 ➔ Done ⚪).
  - `herdr-collie.hideHerdrSidebar` (default: `true`):
    When launching `herdr` in the VS Code integrated terminal, this automatically hides Herdr's built-in TUI sidebar (spaces / agents) to avoid duplicating the Herdr Collie sidebar in VS Code. Theme and keybinding configurations from `~/.config/herdr/config.toml` are preserved and synchronized automatically.
  - **Cross-Session Dispatch**:
    When sending context, Git diffs, or terminal logs from VS Code, all panes and agents across active sessions (`default`, `vscode`, etc.) are listed so you can send context directly to any target session.
  - **Session Management**:
    Manage sessions directly from the **Sessions** sidebar view with one-click switching, new session creation (`+`), and inline deletion (`$(trash)`).
