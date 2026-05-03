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

## Maintainer spec

See [`SPEC.md`](./SPEC.md) for DAG engine, payload store, dependency resolution, and full-suite compatibility rules.

## Test

```bash
npm test
```