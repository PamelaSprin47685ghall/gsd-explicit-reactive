# Explicit Reactive Spec

Version: `5.1.0`.

`README.md` explains usage. This file defines the DAG engine, payload store, dependency resolution, and compatibility contract.

## Public surface

| Capability | Names |
|---|---|
| Tools | `_wait_for_dag_completion` |
| Hooks | `session_start`, `session_shutdown` |
| Commands | none |

## DAG engine

The DAG reads a DEPS file that lists task IDs and their dependencies. Tasks with all dependencies met are eligible for dispatch. The engine dispatches eligible tasks, waits for completion, and repeats until all tasks are done or a failure blocks progress.

### Width-1 enforcement

By default, only one task runs at a time. If the engine encounters an already-running task when dispatching, it emits a one-time warning per unit and proceeds. The warning map is cleared on session shutdown to prevent memory leaks across sessions.

### Failure handling

- **Dependency failure**: If a task's prerequisite failed, the task is marked blocked and skipped.
- **Deadlock detection**: If no tasks are running and no tasks are eligible, the engine reports a deadlock.
- **Back-to-plan**: On error, the engine can route back to the plan phase with a structured error message, giving the agent a chance to replan.

### State persistence

Task status is persisted to per-task state files on disk. The engine reads these on startup to reconstruct DAG progress.

Rules:
- State files are written atomically (`writeFileSync` with subsequent rename or direct write).
- Missing or corrupt state files default to `pending`.
- TOCTOU protection: read operations use try/catch on `readFileSync` rather than `existsSync`+`readFileSync`.

## Payload store

Tool-call payloads are stored in a TTL-based in-memory store so the dispatch tool can reference them between agent turns.

Rules:
- Payloads have a configurable TTL (default 10 minutes).
- Expired payloads are cleaned up on access.
- `take(key)` atomically retrieves and removes a payload, preventing stale references.
- `get(key)` + `delete(key)` remains available but non-atomic; prefer `take()` for single-consumption patterns.

## Dependency resolution

Dependencies are resolved by reading the DEPS file at session start. The resolution process:

1. Reads the DEPS file from the active milestone/slice/task path.
2. Constructs a directed graph from (task → dependencies).
3. Detects cycles and reports them as errors.
4. Provides topological order for width-1 execution.

## Full-suite compatibility

Explicit Reactive must coexist with the rest of the suite:

- `_wait_for_dag_completion` tool registration is idempotent (guarded by WeakSet).
- Width-1 violations emit warnings via `pi.notify()`, not via error throwing.
- Error messages routed back to the agent use plain language, not internal state codes.
- Forked sessions and subagents must inherit the extension through bundled-extension self-injection.

## Session creation architecture

### Critical discovery: SDK vs Extension API

During development, we discovered a critical distinction in GSD's architecture:

**The `pi` object (Extension API) ≠ Session creation API**

#### What the Extension API provides

The `pi` object passed to extensions (`export default function(pi)`) is the **Extension API**, which provides:

```typescript
interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  on(event: string, handler: Function): void;
  events: EventEmitter;
  // ... other extension lifecycle methods
}
```

#### What it does NOT provide

The Extension API does **NOT** include session creation methods. Specifically:
- ❌ `pi.createAgentSession()` - does not exist
- ❌ `pi.newSession()` - does not exist

#### Correct approach: Import from SDK

To create parallel agent sessions (required for DAG task workers), import directly from the SDK:

```javascript
import { createAgentSession } from "@gsd/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: process.cwd(),
  model: parentModel,
  tools: [...],
  // ... other options
});
```

#### Why this matters for DAG execution

The DAG engine needs to spawn multiple parallel agent sessions to execute tasks concurrently. Each task runs in its own isolated session with:
- Independent context window
- Separate tool runtime
- Isolated working directory (optional worktree)

Attempting to use `pi.createAgentSession()` results in:
```
DAG initialization failed: pi.createAgentSession unavailable
```

#### Tool execution context limitations

When a tool's `execute` function runs, it receives:
- `ctx` - tool execution context (NOT `ExtensionCommandContext`)
- `signal` - AbortSignal
- `onUpdate` - streaming callback

The `ctx` object in tool execution:
- ✅ Has `ctx.session` (current session, read-only)
- ✅ Has `ctx.model`, `ctx.cwd`, etc.
- ❌ Does NOT have `ctx.newSession()` (that's only on `ExtensionCommandContext`)

#### Reference implementations

Production examples of parallel session management:
- [`pi-subagents`](https://github.com/tintinweb/pi-subagents) - spawns specialized agents
- This extension (`gsd-explicit-reactive`) - DAG task workers

Both use `createAgentSession` from the SDK, not from `pi`.

#### Historical context

This issue was discovered when the DAG tool failed with "pi.createAgentSession unavailable". Investigation revealed:

1. Initial assumption: `pi` object should have session creation methods
2. Reality: Extension API and Session API are separate concerns
3. Solution: Import `createAgentSession` from SDK package
4. Lesson: Extension API is for registration/hooks, not session lifecycle

This architectural separation makes sense:
- Extensions register capabilities (tools, commands, hooks)
- SDK provides primitives for building those capabilities (session creation, resource loading)
- Clear separation of concerns prevents API bloat

## Verification

```bash
npm test
```