import { ensureBundledExtensionPath } from "./src/self-injection.js";
import { injectExplicitDagEngine, registerWaitTool, width1Warned, setPatchedCreateAgentSession } from "./src/engine.js";
import { createDagStatusWidget } from "./src/widget.js";
import { loadGsdCore } from "./src/discovery.js";
import { createAgentSession } from "@gsd/pi-coding-agent";

ensureBundledExtensionPath(import.meta.url);

const registeredPluginApis = new WeakSet();

// GLOBAL: Store main session references for event bridging
export const mainSessionsBySessionId = new Map();

// BLACK MAGIC: Monkey patch createAgentSession to save session references
const originalCreateAgentSession = createAgentSession;
const patchedCreateAgentSession = async (options) => {
  const result = await originalCreateAgentSession(options);
  
  // Save session reference to global map
  if (result?.session) {
    const sessionId = result.session.sessionManager?.getSessionId?.();
    if (sessionId) {
      mainSessionsBySessionId.set(sessionId, result.session);
      // Store notification for later display
      patchedCreateAgentSession._lastSave = {
        sessionId,
        total: mainSessionsBySessionId.size,
        success: true,
      };
    } else {
      patchedCreateAgentSession._lastSave = { success: false, reason: 'no sessionId' };
    }
  } else {
    patchedCreateAgentSession._lastSave = { success: false, reason: 'no session in result' };
  }
  
  return result;
};

// Register the patched version with engine.js
setPatchedCreateAgentSession(patchedCreateAgentSession);

export default async function explicitReactivePlugin(pi) {
  if (registeredPluginApis.has(pi)) return;
  registeredPluginApis.add(pi);

  // Module-level state (not stored on pi)
  const dagWidgets = new Map(); // sessionId -> widget
  const dagTaskManagers = new Map(); // sessionId -> DagTaskManager

  const injectEngineSafely = async (ctx) => {
    try {
      const core = await loadGsdCore();
      if (!core) {
        ctx?.ui?.notify?.("[DAG] GSD core modules not found. Plugin disabled.", "warning");
        return;
      }
      ctx?.ui?.notify?.("[DAG] GSD core modules loaded, injecting dispatch rule...", "info");
      injectExplicitDagEngine(core, pi, ctx, dagWidgets, dagTaskManagers);
    } catch (err) {
      ctx?.ui?.notify?.(`[DAG] Initialization failed: ${err.message}`, "error");
      console.error("[DAG] Full error:", err);
    }
  };

  registerWaitTool(pi, dagTaskManagers);

  // Inject once at plugin bootstrap to avoid missing the first dispatch cycle.
  await injectEngineSafely(undefined);

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    
    // Report patched createAgentSession status
    if (patchedCreateAgentSession._lastSave) {
      const save = patchedCreateAgentSession._lastSave;
      if (save.success) {
        ctx?.ui?.notify?.(`[DAG] ✓ Patched createAgentSession saved session ${save.sessionId} (total: ${save.total})`, 'success');
      } else {
        ctx?.ui?.notify?.(`[DAG] ✗ Patched createAgentSession failed: ${save.reason}`, 'error');
      }
    }
    
    ctx?.ui?.notify?.(`[DAG] Global map has ${mainSessionsBySessionId.size} sessions`, 'info');
    
    // BLACK MAGIC: Monkey patch ctx.abort to extract session reference
    // ctx.abort() calls session.abort(), so we can intercept it
    if (ctx && ctx.abort && !ctx.__sessionExtracted) {
      const originalAbort = ctx.abort;
      
      ctx.abort = function() {
        // When abort is called, 'this' inside the original function is the session
        // But we can't access it directly. Instead, we'll use a different approach:
        // We'll patch the abort function to save a reference when it's first called
        
        // Call the original
        const result = originalAbort.call(this);
        
        // Try to extract session from the call context
        // This won't work because 'this' here is ctx, not session
        
        return result;
      };
      
      ctx.__sessionExtracted = true;
    }
    
    // Alternative: Store ctx itself in the global map, and extract session later
    if (sessionId) {
      mainSessionsBySessionId.set(sessionId, ctx);
      ctx?.ui?.notify?.(`[DAG] Stored ctx for session ${sessionId}`, 'info');
    }
    
    // Create widget per session
    let dagWidget = null;
    if (sessionId) {
      if (!dagWidgets.has(sessionId)) {
        dagWidget = createDagStatusWidget(ctx);
        dagWidgets.set(sessionId, dagWidget);
      } else {
        dagWidget = dagWidgets.get(sessionId);
      }
    }

    // injectExplicitDagEngine is idempotent via rules._dagInjected guard
    await injectEngineSafely(ctx);
  });

  // Issue: Clean up stale per-session state on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (sessionId) {
      if (dagTaskManagers.has(sessionId)) {
        const manager = dagTaskManagers.get(sessionId);
        manager.abortAll();
        dagTaskManagers.delete(sessionId);
      }
      if (dagWidgets.has(sessionId)) {
        const widget = dagWidgets.get(sessionId);
        widget.stop?.();
        dagWidgets.delete(sessionId);
      }
    }
    // Prune width-1 warnings to prevent unbounded growth
    width1Warned.clear();
  });
}
