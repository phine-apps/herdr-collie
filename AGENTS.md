# AGENTS.md — Herdr Collie AI Agent Guidelines

This document provides critical architectural context, constraints, and operational rules for AI coding agents (Claude Code, Antigravity, Cursor Agent, Copilot, etc.) working on the **Herdr Collie** codebase.

---

## 1. Project Overview & Role

**Herdr Collie** is a VS Code extension that bridges Visual Studio Code with the **Herdr** multi-agent CLI/TUI platform. It enables developers to:
- Launch and orchestrate AI agents inside isolated Git worktrees.
- Monitor agent swarm states via an interactive Attention HUD and StatusBar indicators.
- Share rich editor context (code selections, hover symbols, diagnostics, SCM diffs, and terminal outputs).
- Conduct inline code reviews with checkpoints, rollbacks, and structured diff-to-prompt feedback dispatch.

---

## 2. Essential Commands

Always use `pnpm` (version 10) for package management:

```bash
# Dependencies & Setup
pnpm install

# Build & Compilation
pnpm run compile           # TypeScript compile check (`tsc -p ./`)
pnpm run build             # Production bundle via esbuild into dist/extension.js
pnpm run watch             # TypeScript watch mode for development

# Testing
pnpm test                  # Runs all tests (Unit + Integration)
pnpm run test:unit         # Unit tests only (`mocha -r ts-node/register 'src/test/unit/**/*.test.ts'`)
pnpm run test:integration  # Integration tests only (`mocha -r ts-node/register 'src/test/integration/**/*.test.ts'`)

# Packaging & Verification
pnpm run package           # Packages extension into .vsix bundle via @vscode/vsce
```

---

## 3. Architecture & Key Modules Map

```
src/
├── extension.ts               # Main extension entrypoint, command registrations, lifecycle
├── socketClient.ts            # Unix domain socket client & JSON-RPC protocol bridge to Herdr daemon
├── worktreeManager.ts         # Git worktree lifecycle: provisioning, branch sanitation, merging, cleanup
├── agentHUD.ts                # Real-time Attention HUD: status bar live item & approval notifications
├── workspaceHUD.ts            # Status bar active workspace indicator & switcher
├── reviewManager.ts           # Visual review: inline comments, checkpoints, rollback, diff-to-prompt
├── microTaskManager.ts        # Micro-task delegation: CodeLens and QuickFix diagnostic providers
├── workspaceDragAndDrop.ts    # Drag-and-drop reordering for Herdr workspace tree view
├── configManager.ts           # Embedded TOML configuration sync (auto-hiding Herdr TUI sidebar)
├── parsers.ts                 # Resilient CLI JSON & snapshot parsers
├── formatters.ts              # Markdown context formatters & prompt injection escaping
├── executors.ts               # Safe CLI execution wrappers (execHerdr, runGitCmd, process inspection)
└── test/
    ├── helpers/
    │   └── mockVscode.ts      # Complete in-memory mock for VS Code API (for headless testing)
    ├── unit/                  # Fast, isolated unit tests for individual modules
    └── integration/           # Multi-module integration tests (Socket, SCM, Worktrees, HUD)
```

---

## 4. Strict Invariants & Engineering Rules

### A. Testing Invariant (Headless Node.js Execution)
- All unit and integration tests run directly in Node.js without the VS Code Electron binary.
- **Rule**: Any test file or helper that depends on `vscode` APIs **MUST** import `../helpers/mockVscode` as its **very first import line**:
  ```typescript
  import '../helpers/mockVscode'; // Must be first to install global mock
  ```
- Before creating a new test file, inspect `src/test/helpers/mockVscode.ts` to see available mock states and spies. Call `resetMockState()` in `beforeEach` to prevent cross-test contamination.

### B. Shell & Security Safety
- **Rule**: Never interpolate unsanitized strings directly into shell commands.
- Use `execHerdr(args, options)` or `runGitCmd(args, cwd)` which pass arguments as discrete arrays to `execFile`.
- When generating command strings for terminal execution (such as `buildAgentLaunchCommand`), always sanitize prompts using `quoteForShell` and normalize newlines to spaces to prevent shell breakout:
  ```typescript
  quoteForShell(prompt.replace(/[\r\n]+/g, ' '))
  ```
- Validate all user-supplied branch names with `validateBranchName` and session names with `validateSessionName` to reject option injection (e.g. names starting with `-`) or directory traversal (`../`).

### C. Prompt Injection & Code Fence Escaping
- When formatting user code or file snippets into Markdown prompts for AI agents in `formatters.ts`, always use `formatCodeFence(content, language)`:
  - If the content contains triple backticks (` ``` `), the fence dynamically expands to ` ```` ` or more to prevent prompt breakout.

### D. Localization (l10n / NLS) Parity
- **Rule**: Never hardcode user-facing UI messages in English or Japanese inside code.
- Always wrap messages with `@vscode/l10n`:
  ```typescript
  import * as l10n from '@vscode/l10n';
  l10n.t('Your localized string {0}', arg);
  ```
- Whenever you add or modify a command title, configuration description, or notification message, maintain 100% parity across:
  - Manifest NLS: `package.nls.json` (English), `package.nls.ja.json` (Japanese), `package.nls.zh-cn.json` (Chinese)
  - Runtime Bundles: `l10n/bundle.l10n.json`, `l10n/bundle.l10n.ja.json`, `l10n/bundle.l10n.zh-cn.json`
- Parity is strictly verified by `src/test/unit/l10n.test.ts`.

### E. Packaging & File Exclusion Rules
- Always keep `.vscodeignore` clean.
- Never commit generated `.vsix` packages or `.log` files to Git.
- Never bundle duplicate or unoptimized media into `media/`. The VSIX package size must remain under 500 KB.

---

## 5. Verification Checklist for Agents

Before completing any task:
1. Run `pnpm run compile` to verify zero TypeScript errors.
2. Run `pnpm test` (or `pnpm run test:unit` & `pnpm run test:integration`) to ensure all tests pass.
3. If new UI strings were added, ensure `src/test/unit/l10n.test.ts` passes.
4. Run `pnpm run package` to ensure the VSIX builds without warning.
