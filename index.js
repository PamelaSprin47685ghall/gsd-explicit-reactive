import { ensureBundledExtensionPath } from "./src/self-injection.js";
import { injectExplicitDagEngine } from "./src/engine.js";
import { createDagStatusWidget } from "./src/widget.js";
import { loadGsdCore } from "./src/discovery.js";

ensureBundledExtensionPath(import.meta.url);

const registeredPluginApis = new WeakSet();

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
      injectExplicitDagEngine(core, pi, ctx, dagWidgets, dagTaskManagers);
    } catch (err) {
      ctx?.ui?.notify?.(`[DAG] Initialization failed: ${err.message}`, "error");
    }
  };

  // Inject once at plugin bootstrap to avoid missing the first dispatch cycle.
  await injectEngineSafely(undefined);

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    
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

  // Issue 9: Clean up background agents on session shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (sessionId) {
      // Clean up task manager
      if (dagTaskManagers.has(sessionId)) {
        const manager = dagTaskManagers.get(sessionId);
        manager.abortAll();
        dagTaskManagers.delete(sessionId);
      }
      // Clean up widget
      if (dagWidgets.has(sessionId)) {
        const widget = dagWidgets.get(sessionId);
        widget.stop?.();
        dagWidgets.delete(sessionId);
      }
    }
  });
}
