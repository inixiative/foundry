# AGENT-003: Tool Observation Signal Emission

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: High
**Created**: 2026-04-09
**Updated**: 2026-04-09

---

## Overview

When Claude Code executes tools (file writes, bash commands, etc.), the harness should emit `tool_observation` signals that trigger domain guards. This is the bridge between execution (Loop 2) and correctness checking (Loop 3).

Currently `start.ts` has a `signals.onAny()` listener skeleton for tool observations, but no actual tool events flow through it — two concrete gaps remain:

1. **Hook script not written to disk**: `ClaudeCodeRuntime.generateHookScript()` produces the PostToolUse hook content, but nothing calls it during `inject()` or startup to write `.foundry-hook.mjs` to the project directory.
2. **No callback receiver**: The hook script POSTs to `FOUNDRY_HOOK_CALLBACK`, but the viewer has no `POST /api/hooks/tool` endpoint to receive these callbacks and emit them as signals.

## Key Components

- **PostToolUse hook**: Claude Code's hook system fires after each tool call. Foundry needs to capture these events.
- **Signal emission**: Convert tool events into `tool_observation` signals with `{ tool, input, output, filesAffected }`
- **Guard triggering**: FlowOrchestrator.postAction() receives observations and runs domain guards
- **Trigger gating**: Security guard fires on Write/Edit/Bash. Convention guard fires on code file writes. Architecture guard fires on cross-module edits.

## Architecture

```
Claude Code executes tool
       │
       ▼
PostToolUse hook fires
       │
       ▼
Signal: tool_observation
  { tool: "Write", filesAffected: ["auth/middleware.ts"] }
       │
       ▼
FlowOrchestrator.postAction()
       │
       ├─→ Security Guard: "did this introduce a vulnerability?"
       ├─→ Convention Guard: "does this follow naming conventions?"
       └─→ Architecture Guard: "does this cross module boundaries?"
       │
       ▼
Findings → Librarian → thread-state layer
```

## Tasks

### Gap 1: Hook script write-to-disk
- [ ] Call `generateHookScript()` during `ClaudeCodeRuntime.inject()` to write `.foundry-hook.mjs` to project root
- [ ] Set `FOUNDRY_HOOK_CALLBACK` env var when spawning Claude Code session (points to viewer's callback endpoint)
- [ ] Ensure Claude Code's `settings.json` (or `.claude/settings.json`) includes the PostToolUse hook entry

### Gap 2: Callback receiver endpoint
- [ ] Add `POST /api/hooks/tool` route in viewer control routes
- [ ] Parse incoming tool event payload from hook script
- [ ] Emit `tool_observation` signal into the thread's signal bus
- [ ] Define `ToolObservation` type: `{ tool, input, output, filesAffected, timestamp }`

### Gap 3: Signal → Guard pipeline
- [ ] Map tool names to affected domains (Write → security+convention, Bash → security)
- [ ] Implement trigger gating in FlowOrchestrator (which guards fire for which tools)
- [ ] Rate-limit guard checks (don't fire on every single file read)
- [ ] Surface critical guard findings in viewer event stream

## Guard Trigger Matrix

| Tool | Security | Convention | Architecture |
|------|----------|------------|--------------|
| Write/Edit | Yes | Yes (code files) | Yes (cross-module) |
| Bash | Yes | No | No |
| Read | No | No | No |
| Glob/Grep | No | No | No |

## Definition of Done

- [ ] File write triggers convention + security guards
- [ ] Bash execution triggers security guard
- [ ] Read-only tools don't trigger guards (no noise)
- [ ] Critical findings appear in viewer event stream
- [ ] Guard findings feed into Librarian → thread-state

## Related

- **Depends on**: FlowOrchestrator (postAction) — done
- **Depends on**: Domain Librarians (guard mode) — done
- **Blocks**: AGENT-002 (writeback needs observations to adjust trust)
- **Reference**: `docs/FLOW.md` Loop 3, guard tiers

---

_High priority for correctness checking. The guard infrastructure exists but has no input signals yet._
