# Troubleshooting Guide

## "DAG initialization failed: createAgentSession unavailable"

### Symptom

When the `_wait_for_dag_completion` tool executes, it fails with:

```
DAG initialization failed: createAgentSession unavailable
```

### Root Cause

The extension was attempting to call `pi.createAgentSession()`, which does not exist. This is a common mistake when developing GSD extensions that need to create parallel agent sessions.

### Why This Happens

**The `pi` object is the Extension API, not the Session API.**

When GSD loads an extension:

```javascript
export default function(pi) {
  // pi is the Extension API
  // It provides: registerTool, on, events, etc.
  // It does NOT provide: createAgentSession, newSession, etc.
}
```

The Extension API is designed for:
- Registering tools, commands, hooks
- Listening to lifecycle events
- Cross-extension communication

It is **NOT** designed for:
- Creating new sessions
- Managing session lifecycle
- Spawning parallel agents

### Solution

Import `createAgentSession` directly from the SDK:

```javascript
import { createAgentSession } from "@gsd/pi-coding-agent";

// Later, in your tool or async function:
const { session } = await createAgentSession({
  cwd: process.cwd(),
  model: parentModel,
  tools: availableTools,
  // ... other options
});
```

### Complete Fix

**Before (incorrect):**

```javascript
const resolveCreateSessionFactory = (pi) => {
  if (!pi || typeof pi?.createAgentSession !== "function") return null;
  return pi.createAgentSession;  // ❌ This doesn't exist
};
```

**After (correct):**

```javascript
import { createAgentSession } from "@gsd/pi-coding-agent";

const resolveCreateSessionFactory = () => {
  return createAgentSession;  // ✅ Import from SDK
};
```

### Context: Tool Execution Environment

When a tool's `execute` function runs, it receives a `ctx` object that is **NOT** the same as `ExtensionCommandContext`.

**Tool execution context:**
```typescript
interface ToolExecutionContext {
  session: AgentSession;      // Current session (read-only)
  model: Model;
  cwd: string;
  tools: Tool[];
  // ... other read-only properties
  // ❌ Does NOT have: newSession(), fork(), etc.
}
```

**Extension command context (only in command handlers):**
```typescript
interface ExtensionCommandContext extends ExtensionContext {
  newSession(options?): Promise<{ cancelled: boolean }>;  // ✅ Available here
  fork(entryId: string): Promise<{ cancelled: boolean }>;
  // ... other session management methods
}
```

### When You Need Parallel Sessions

If your extension needs to spawn parallel agent sessions (like DAG task workers or subagents), you have two options:

1. **Import from SDK** (recommended for most cases):
   ```javascript
   import { createAgentSession } from "@gsd/pi-coding-agent";
   ```

2. **Use subprocess spawning** (for full isolation):
   ```javascript
   import { spawn } from "node:child_process";
   // Spawn a new `pi` process
   ```

### Reference Implementations

Production examples that correctly use `createAgentSession`:

- **[pi-subagents](https://github.com/tintinweb/pi-subagents)** - Spawns specialized agents with custom prompts
- **gsd-explicit-reactive** (this extension) - DAG task workers

Both import `createAgentSession` from the SDK package.

### Architectural Insight

This separation is intentional and follows good design principles:

| Concern | API | Purpose |
|---------|-----|---------|
| Extension lifecycle | Extension API (`pi` object) | Register capabilities, hook into events |
| Session management | SDK functions | Create sessions, manage resources |
| Tool execution | Tool context (`ctx`) | Read-only access to current session |
| Command execution | Command context | Full session control (fork, switch, etc.) |

**Key takeaway:** Extension API is for registration/hooks. SDK provides primitives for building those capabilities.

### Historical Context

This issue was discovered during development when:

1. Initial assumption: `pi` object should have everything
2. Runtime error: `pi.createAgentSession unavailable`
3. Investigation: Checked `pi-subagents` source code
4. Discovery: They import from SDK, not from `pi`
5. Root cause: Extension API ≠ Session API
6. Solution: Import `createAgentSession` from `@gsd/pi-coding-agent`

This documentation exists to prevent future developers from making the same mistake.

### Related Issues

- "Cannot read property 'createAgentSession' of undefined"
- "pi.createAgentSession is not a function"
- "Session creation failed in tool execution"

All of these point to the same root cause: trying to use Extension API for session management.

### Quick Checklist

If you're building a GSD extension that needs parallel sessions:

- [ ] Import `createAgentSession` from `@gsd/pi-coding-agent`
- [ ] Do NOT try to call `pi.createAgentSession()`
- [ ] Do NOT expect `ctx.newSession()` in tool execution
- [ ] Reference `pi-subagents` for production patterns
- [ ] Test with actual parallel execution, not just single-task flows

### Further Reading

- [Extension API documentation](../../docs/extension-sdk/api-reference.md)
- [SDK documentation](../../packages/pi-coding-agent/README.md)
- [pi-subagents source](https://github.com/tintinweb/pi-subagents)
