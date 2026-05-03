# Explicit Reactive

Deterministic DAG-based parallel task dispatch for GSD auto-mode. Executes task plans as dependency graphs with width-1 enforcement, payload persistence, and structured error recovery.

Version: `5.1.0`.

## What it provides

| Capability | Name |
|---|---|
| Tools | `_wait_for_dag_completion` |
| Hooks | `session_start`, `session_shutdown` |
| Commands | none |

## How it works

When auto-mode dispatches a slice plan, Explicit Reactive:

1. Reads the dependency graph (DEPS file) and constructs a DAG.
2. Dispatches tasks whose dependencies are met, enforcing width-1 (one-at-a-time) execution by default.
3. Persists tool-call payloads to disk so the dispatch tool can reference them between turns.
4. Tracks per-task status (pending → running → complete/failed) with structured state files.
5. On failure, supports structured error recovery: back-to-plan or retry strategies.

The `_wait_for_dag_completion` tool is registered so the agent can block until all in-flight DAG tasks finish.

## Operational notes

- DAG state persists across agent turns within a session.
- Width-1 enforcement produces a warning on first violation, then proceeds.
- Payload storage uses a TTL-based store with automatic cleanup.
- Session shutdown clears all in-memory state and payload store.
- Forked sessions inherit the extension automatically.

## Critical implementation detail: createAgentSession

**⚠️ IMPORTANT**: When creating parallel agent sessions in GSD extensions, you MUST import `createAgentSession` directly from the SDK, NOT from the `pi` object.

### Correct approach

```javascript
import { createAgentSession } from "@gsd/pi-coding-agent";

// Use the imported function directly
const { session } = await createAgentSession(options);
```

### ❌ Common mistake

```javascript
// This does NOT exist and will fail at runtime
const session = await pi.createAgentSession(options);
```

### Why this matters

The `pi` object passed to extensions is the **Extension API**, which provides:
- `pi.registerTool()` - register tools
- `pi.on()` - hook into lifecycle events  
- `pi.events` - event emitter for cross-extension communication

It does **NOT** provide session creation methods. Those live in the SDK as standalone functions.

### Reference implementation

See [`pi-subagents`](https://github.com/tintinweb/pi-subagents) for a production example of parallel agent session management using `createAgentSession` from the SDK.

### Context: Tool execution environment

When a tool's `execute` function runs, it receives:
- `ctx` - tool execution context (NOT `ExtensionCommandContext`)
- `signal` - AbortSignal for cancellation
- `onUpdate` - streaming update callback

The `ctx` object does NOT have `newSession()` - that method only exists on `ExtensionCommandContext` (available in command handlers, not tool handlers).

For parallel task execution (like DAG workers), you need to create independent sessions using the SDK's `createAgentSession` function.

## Maintainer spec

See [`SPEC.md`](./SPEC.md) for DAG engine, payload store, dependency resolution, and full-suite compatibility rules.

## Test

```bash
npm test
```