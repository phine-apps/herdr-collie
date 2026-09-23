# Herdr Collie — Future Roadmap & Feature Backlog (TODO)

This document tracks future feature candidates (P3 to P6) and expansion ideas for **Herdr Collie**.
To keep the initial release lightweight, intuitive, and focused on the core developer experience, these features are staged for future iterative releases based on user feedback.

---

## 🚀 Released in Current Version (v0.1.0)
- ✅ **High-Signal Context Bridge**: Send Selection, Symbols/Types (Hover), Diagnostics & Workspace Problems, SCM Diffs (Staged/Unstaged), Branch Context, and Terminal Logs.
- ✅ **Optimized Terminal & Session Synchronization**: Auto-hidden Herdr TUI sidebar inside VS Code terminal, cross-session switcher, and embedded TOML config synchronization.
- ✅ **[P1] Smart Swarm & Git Worktree Launcher**: One-click Git worktree provisioning, Herdr workspace creation, agent spawning, and inline merge/cleanup.
- ✅ **[P2] Agent Attention HUD & Quick-Action Notifications**: Status bar live indicators (`Working` / `Waiting` / `Idle`) and zero-context-switch interactive notification approvals (`Approve (y)`, `Deny (n)`, `Quick Reply`, `Focus Terminal`).
- ✅ **[P3] Integrated Review & Diff-to-Prompt**: Native visual review, inline commenting (`vscode.comments`), "Review Changes" sidebar tree (`herdr-collie.reviewChanges`), single-click diff editor (`HEAD ↔ Working Tree`), automated pre-review checkpointing, one-click rollback, and structured diff-to-prompt feedback dispatch.

---

## 🔮 Future Feature Backlog (P4 ~ P8)

### 📌 P4: Micro-Task CodeLens & Quick Dispatch (コードレンズ & インライン指示)
* **Goal**: Minimize clicks required to trigger agent assistance on specific functions, failing tests, or compiler errors.
* **Key Capabilities**:
  1. **Test-Runner CodeLens**: Displays `▶ Fix Test with Herdr Agent` / `🧪 Generate Edge Cases` directly above test function signatures when tests fail.
  2. **Diagnostic Quick-Fix**: Integrates into the VS Code Lightbulb menu (`Cmd+.`) as `🛠️ Delegate Fix to Herdr Agent`.
  3. **Smart Keyboard Dispatch (`Cmd+Enter` / `Option+Enter`)**: Context-aware shortcut that dispatches the current function or markdown task item to the nearest idle agent.
* **Technical Considerations**:
  - Implements `vscode.languages.registerCodeLensProvider` and `vscode.languages.registerCodeActionsProvider`.
  - Reuses existing AST and diagnostic formatters from `src/formatters.ts`.

---

### 📌 P5: Collie Mission Control (マルチエージェント同時監視 Webview)
* **Goal**: Provide a clean, unified bird's-eye dashboard for developers managing 3+ parallel agents without cluttering the screen with multiple terminal splits.
* **Key Capabilities**:
  1. **Card-Based Agent Dashboard**: Webview panel showing cards for all active agents across sessions.
  2. **Real-Time Tool / Step Visualizer**: Displays structured summaries (e.g. `claude: editing src/auth.ts`, `antigravity: running vitest`).
  3. **Swarm Metrics**: Token usage estimates, elapsed run time, and step counts per agent.
* **Technical Considerations**:
  - Implemented via VS Code Webview API with low-overhead JSON-RPC events from Herdr Socket API (`session.snapshot` and `events.subscribe`).

---

### 📌 P6: Herdr Plugin Bridge & Deep Linking (プラグイン拡張 & `herdr://` リンク)
* **Goal**: Seamlessly synchronize Herdr's custom plugins (`manifest.json`) and URL schemes with VS Code.
* **Key Capabilities**:
  1. **Dynamic Plugin Action Palette**: Discovers third-party Herdr plugins via `herdr plugin list --json` and exposes their actions in VS Code menus dynamically.
  2. **`herdr://` Deep Link Handler**: Clicking links like `herdr://workspace/auth/pane/2` in terminal or markdown automatically focuses that workspace and pane in VS Code.
* **Technical Considerations**:
  - Implements VS Code `vscode.window.registerUriHandler` for custom protocol handling.

---

### 📌 P7: Multi-Language & Internationalization (多言語対応: 英語・日本語・中国語)
* **Goal**: Provide native localization support for English, Japanese, and Simplified Chinese across the entire VS Code extension.
* **Key Capabilities**:
  1. **VS Code Official L10n Framework (`@vscode/l10n`)**: Externalize all UI notifications, dialogs, QuickPick titles/placeholders, and worktree wizard prompts into `l10n/bundle.l10n.*.json`.
  2. **Static Manifest Localization (`package.nls.*.json`)**: Localize command titles in Command Palette, configuration property descriptions, and sidebar view/container names into English (`package.nls.json`), Japanese (`package.nls.ja.json`), and Simplified Chinese (`package.nls.zh-cn.json`).
  3. **Agent Prompt Language Selection**: Provide `herdr-collie.promptLanguage` (`"auto"` | `"en"` | `"ja"` | `"zh-cn"`) to let developers choose whether injected context instructions (diagnostics, terminal outputs) are formatted in English or the user's local language.
  4. **Automated Extraction Workflow**: Integrate `@vscode/l10n-dev` to automatically discover and extract strings during build and CI verification.
* **Technical Considerations**:
  - Zero runtime overhead via VS Code native language pack integration.
  - Keeps deterministic English prompts as default for AI agent reliability while delivering a fully localized native UI for developers.

---

### 📌 P8: Workspace Awareness & Hierarchical Swarm View (ワークスペース選択状況の可視化 & 階層ビュー)
* **Goal**: Enable developers to clearly see which workspace is active, identify the matching local VS Code project folder, and visualize the agents/panes running inside each workspace.
* **Key Capabilities**:
  1. **Status Bar Workspace HUD**: Dedicated status bar indicator (e.g. `$(folder-active) [WS: main]` or `$(git-branch) feat/auth [Active]`) showing the currently focused Herdr workspace with one-click switcher.
  2. **Hierarchical Workspace Tree (親子階層ビュー)**: Transform the Workspaces sidebar view into collapsible tree items that expand to display active agents and terminal panes running within that workspace.
  3. **Visual Active & Local Indicators**:
     - Distinct `[Active in Herdr]` badge / icon for the focused Herdr workspace (retaining focus awareness even for Git Worktree workspaces).
     - `[Current Window]` badge for Herdr workspaces matching the currently open VS Code project path.
     - Inline agent count and status summaries in descriptions (e.g. `feat/auth • 2 agents (1 running)`).
  4. **Auto-Sync Workspace Focus (Optional)**: Add `herdr-collie.autoSyncWorkspaceWithEditor` setting to automatically synchronize Herdr workspace focus when switching files or projects in VS Code.
* **Technical Considerations**:
  - Extends `HerdrWorkspaceProvider` with hierarchical `getChildren` support (`vscode.TreeItemCollapsibleState.Collapsed`).
  - Leverages Herdr Socket API snapshots and terminal focus events for instantaneous updates with zero polling overhead.

---

## 🎯 Review & Prioritization Criteria
When evaluating which feature to implement next:
1. **User Feedback & Telemetry**: Which friction points are reported most by active developers?
2. **Cognitive Simplicity**: Does the new feature add natural power without complicating the existing interface?
3. **Multi-Agent Scale**: Does the feature improve developer flow when scaling from 1 to N parallel agents?
