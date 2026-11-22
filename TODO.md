# Herdr Collie — Future Roadmap & Feature Backlog (TODO)

This document tracks future feature candidates (P3 to P6) and expansion ideas for **Herdr Collie**.
To keep the initial release lightweight, intuitive, and focused on the core developer experience, these features are staged for future iterative releases based on user feedback.

---

## 🚀 Released in Current Version (v0.1.0)
- ✅ **High-Signal Context Bridge**: Send Selection, Symbols/Types (Hover), Diagnostics & Workspace Problems, SCM Diffs (Staged/Unstaged), Branch Context, and Terminal Logs (with Shell Integration failure QuickFix).
- ✅ **Optimized Terminal & Session Synchronization**: Auto-hidden Herdr TUI sidebar inside VS Code terminal, terminal auto-restore, cross-session switcher, and embedded TOML config synchronization.
- ✅ **[P1] Smart Swarm & Git Worktree Launcher**: One-click Git worktree provisioning, `.env` & `postCreateCommand` bootstrap, GitHub Issue/PR CI integration, comparison scorecards, Swarm Playbooks (Best-of-N / Implementer + Reviewer), Conflict Radar, and inline merge/cleanup.
- ✅ **[P2] Agent Attention HUD & Quick-Action Notifications**: Status bar live indicators (`Working` / `Waiting` / `Idle`), closed-loop diagnostic auto-verification, and zero-context-switch interactive notification approvals (`Approve (y)`, `Deny (n)`, `Quick Reply`, `Focus Terminal`).
- ✅ **[P3] Integrated Review & Diff-to-Prompt**: Native visual review, inline commenting (`vscode.comments`), "Review Changes" sidebar tree (`herdr-collie.reviewChanges`), cross-worktree review target switching, single-click diff editor (`HEAD ↔ Working Tree` / merge-base), automated pre-review checkpointing, one-click rollback, and structured diff-to-prompt feedback dispatch.
- ✅ **[P4] Micro-Task CodeLens & Quick Dispatch**: Test-Runner & TODO CodeLens, Diagnostic Quick-Fix lightbulb action, and Smart Context Dispatch (`Ctrl+Alt+H Enter`).
- ✅ **[P7] Multi-Language & Internationalization**: Full localization parity across English, Japanese, and Simplified Chinese (`package.nls.*.json` and `l10n/bundle.l10n.*.json`).
- ✅ **[P8] Workspace Awareness & Hierarchical View**: Status Bar Workspace HUD (`workspaceHUD.ts`), workspace drag-and-drop reordering, and expandable tab hierarchy in the Workspaces tree.

---

## 🔮 Future Feature Backlog (P5 ~ P6)

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

## 🎯 Review & Prioritization Criteria
When evaluating which feature to implement next:
1. **User Feedback & Telemetry**: Which friction points are reported most by active developers?
2. **Cognitive Simplicity**: Does the new feature add natural power without complicating the existing interface?
3. **Multi-Agent Scale**: Does the feature improve developer flow when scaling from 1 to N parallel agents?
