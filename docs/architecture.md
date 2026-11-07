# Herdr Collie — Architecture & System Design

This document details the internal architecture, module responsibilities, IPC communication protocols, and data flows of **Herdr Collie**.

---

## 1. High-Level System Architecture

Herdr Collie acts as an intelligent bridge connecting the **VS Code Extension Host** to the **Herdr CLI & Daemon** and its managed AI agents via Unix domain sockets and Git worktrees.

```mermaid
flowchart TD
    subgraph VSCode["VS Code Process"]
        subgraph Collie["Herdr Collie Extension"]
            Ext["extension.ts<br/>(Command Routing & Lifecycle)"]
            SockClient["socketClient.ts<br/>(Unix Domain Socket Client)"]
            WorktreeMgr["worktreeManager.ts<br/>(Git Worktree Lifecycle)"]
            AgentHUD["agentHUD.ts<br/>(Attention Queue & HUD)"]
            ReviewMgr["reviewManager.ts<br/>(Inline Review & Checkpoints)"]
            MicroTask["microTaskManager.ts<br/>(CodeLens & QuickFix)"]
            Fmt["formatters.ts<br/>(Markdown & Prompt Escaping)"]
        end
        EditorUI["VS Code Editor & SCM<br/>(Code, Diffs, Problems, Terminal)"]
        StatusBar["VS Code Status Bar & TreeViews"]
    end

    subgraph Herdr["Herdr Platform"]
        SocketFile["Unix Domain Socket<br/>(~/.config/herdr/herdr.sock)"]
        Daemon["Herdr Daemon / Event Broker"]
        subgraph Swarm["Worktree Swarm"]
            Pane1["Terminal Pane 1<br/>(Claude Code)"]
            Pane2["Terminal Pane 2<br/>(Antigravity CLI)"]
            Pane3["Terminal Pane 3<br/>(Custom Agent)"]
        end
    end

    subgraph GitFS["File System & Git"]
        MainRepo["Main Repository Working Tree"]
        Worktree1["Worktree: .worktrees/feat-auth"]
        Worktree2["Worktree: ../repo-fix-bug"]
    end

    EditorUI -->|Context Data| Ext
    Ext --> AgentHUD
    Ext --> ReviewMgr
    Ext --> MicroTask
    Ext --> WorktreeMgr

    AgentHUD --> StatusBar
    SockClient <-->|JSON-RPC / NDJSON| SocketFile
    SocketFile <--> Daemon
    Daemon --> Swarm

    WorktreeMgr -->|git worktree add/merge| GitFS
    Swarm -->|Edits code in| GitFS
```

---

## 2. Core Modules & Responsibilities

| Module | Source File | Responsibilities |
| :--- | :--- | :--- |
| **Extension Entrypoint** | [`src/extension.ts`](file:///src/extension.ts) | Registers all 25+ commands, initializes views, coordinates lifecycle, and wires providers to VS Code. |
| **Socket IPC Client** | [`src/socketClient.ts`](file:///src/socketClient.ts) | Connects to Herdr's Unix domain socket, handles subscriptions (`events.subscribe`), queries snapshots (`session.snapshot`), and dispatches keys/inputs. |
| **Git Worktree Manager** | [`src/worktreeManager.ts`](file:///src/worktreeManager.ts) | Manages worktree provisioning, branch validation/sanitation, prompt quoting (`quoteForShell`), conflict-aware merging, and directory cleanup. |
| **Agent Attention HUD** | [`src/agentHUD.ts`](file:///src/agentHUD.ts) | Real-time status bar HUD, priority-based Attention Queue, unread activity bar counter, and interactive notification approvals. |
| **Workspace HUD** | [`src/workspaceHUD.ts`](file:///src/workspaceHUD.ts) | Dedicated status bar item tracking the focused Herdr workspace with one-click workspace switching. |
| **Integrated Review** | [`src/reviewManager.ts`](file:///src/reviewManager.ts) | Visual review workflow using `vscode.comments`, git checkpoint creation (`createReviewCheckpoint`), rollback, and structured diff-to-prompt dispatch. |
| **Micro-Task Dispatcher** | [`src/microTaskManager.ts`](file:///src/microTaskManager.ts) | Implements `vscode.languages.registerCodeLensProvider` and `registerCodeActionsProvider` (QuickFix) to delegate test fixes, edge-case generation, and TODO items to idle agents. |
| **Context Formatters** | [`src/formatters.ts`](file:///src/formatters.ts) | Formats selections, hover symbols, diagnostics, diffs, and terminal outputs. Implements `formatCodeFence` with dynamic backtick expansion to defend against prompt injection. |
| **Safe CLI Executors** | [`src/executors.ts`](file:///src/executors.ts) | Safely wraps child processes via `execFile` with discrete argument arrays (`execHerdr`, `runGitCmd`), and checks command availability (`which` / `where`). |
| **Config Synchronizer** | [`src/configManager.ts`](file:///src/configManager.ts) | Generates an embedded temporary TOML configuration to auto-hide Herdr's TUI sidebar inside VS Code's integrated terminal. |

---

## 3. Communication Protocols & Data Flows

### A. Socket Protocol (NDJSON over Unix Domain Socket)
Herdr Collie communicates with Herdr's background socket (`~/.config/herdr/herdr.sock` or `~/.config/herdr/sessions/<session>/herdr.sock`) using newline-delimited JSON (NDJSON):

1. **Automatic Subscription**: Upon connecting, Collie subscribes to workspace, tab, pane, and agent lifecycle events:
   ```json
   {"id": "collie_sub", "method": "events.subscribe", "params": {"subscriptions": [{"type": "agent_status"}, ...]}}
   ```
2. **Snapshot Querying**:
   ```json
   {"id": "collie_snap_1", "method": "session.snapshot"}
   ```
3. **Interactive Key / Input Injection**:
   ```json
   {"id": "collie_key_2", "method": "pane.send_keys", "params": {"pane_id": "p-123", "keys": ["y", "Enter"]}}
   ```

### B. Agent Interactive Approval Flow (Sequence Diagram)

When an AI agent requests confirmation (e.g. running a bash command or accessing a file):

```mermaid
sequenceDiagram
    autonumber
    participant Agent as AI Agent (e.g. Claude)
    participant Daemon as Herdr Daemon
    participant Sock as HerdrSocketClient
    participant HUD as AgentHUD
    participant Dev as Developer (VS Code UI)

    Agent->>Daemon: Enters "waiting" / "needs_input" state
    Daemon->>Sock: Push Event: `agent.blocked` {agent_id: "a-1", name: "Worker"}
    Sock->>HUD: emit('agent.blocked')
    HUD->>HUD: Increment Activity Bar Badge
    HUD->>Dev: Show Interactive Popup: "[Approve (y)] [Deny (n)] [Quick Reply...] [Focus Terminal]"
    
    alt Developer clicks Approve (y)
        Dev->>HUD: Click "Approve (y)"
        HUD->>Sock: sendPaneKeys(paneId, ["y", "Enter"])
        Sock->>Daemon: NDJSON: {"method": "pane.send_keys", "params": {"keys": ["y", "Enter"]}}
        Daemon->>Agent: Writes 'y\n' to terminal PTY
        Agent->>Agent: Resumes execution
    else Developer enters Quick Reply
        Dev->>HUD: Input text "Use port 8080 instead"
        HUD->>Sock: sendPaneInput(paneId, "Use port 8080 instead\n")
        Sock->>Daemon: NDJSON: {"method": "pane.send_input", ...}
        Daemon->>Agent: Writes text to terminal PTY
    end
```

### C. Git Worktree Launch Flow (Sequence Diagram)

```mermaid
sequenceDiagram
    autonumber
    participant User as Developer
    participant Ext as extension.ts
    participant WTM as worktreeManager.ts
    participant Git as Git CLI
    participant Herdr as Herdr CLI

    User->>Ext: Trigger "Launch Agent in Git Worktree" (Ctrl+Alt+H L)
    Ext->>User: QuickPick: Branch Name & Target Agent
    User-->>Ext: Branch "feat/auth", Agent "claude", Prompt "Add OAuth"
    Ext->>WTM: launchWorktreeAgent(options)
    WTM->>Git: git rev-parse --show-toplevel
    WTM->>WTM: resolveWorktreePath() & validateBranchName()
    WTM->>Git: git worktree add <path> -b feat/auth
    WTM->>Herdr: execHerdr(["workspace", "create", "feat/auth", "--cwd", <path>])
    WTM->>Herdr: execHerdr(["pane", "spawn", "--command", "claude 'Add OAuth'"])
    WTM-->>Ext: Worktree & Agent launched
    Ext->>User: Show success notification & reveal in Workspaces tree
```

---

## 4. Security & Safety Model

1. **Option Injection Defense**:
   All user-supplied names (branch names, session names, workspace labels) are validated using strict regexes. Names starting with a hyphen (`-`) are rejected to prevent command option injection into Git or CLI tools.
2. **Command Injection Prevention**:
   Discrete argument arrays are passed to `child_process.execFile`. When building terminal launch command strings, all arguments are escaped via `quoteForShell` and embedded newlines are normalized to spaces to prevent terminal shell breakouts.
3. **Prompt Injection & Fence Breakout Defense**:
   `formatCodeFence(content, lang)` counts consecutive backticks in user code. If code contains ` ``` `, the wrapping fence expands to ` ```` ` or higher, preventing untrusted snippets from breaking out of prompt containers.
4. **Checkpointing & Disaster Recovery**:
   Prior to submitting code reviews, `ReviewManager` captures working tree checkpoints via Git, enabling developers to roll back with zero data loss if an agent creates undesirable changes.
