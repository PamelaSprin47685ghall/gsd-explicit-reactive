import { injectExplicitDagEngine } from "./src/engine.js";
import { createDagStatusWidget } from "./src/widget.js";
import { loadGsdCore } from "./src/discovery.js";

export default async function explicitReactivePlugin(pi) {
  // Create and start the DAG status widget once
  const dagWidget = createDagStatusWidget(pi);
  pi._dagWidget = dagWidget;

  // The DagTaskManager is stored here for session_shutdown cleanup.
  // injectExplicitDagEngine will set pi._dagTaskManager when DAG executes.
  pi._dagTaskManager = null;

  pi.on("session_start", async (_event, captureCtx) => {
    // injectExplicitDagEngine is idempotent via rules._dagInjected guard,
    // so no module-level engineInjected flag is needed.
    try {
      const core = await loadGsdCore();
      if (!core) {
        pi.ui?.notify?.("[DAG] GSD core modules not found. Plugin disabled.", "warning");
        return;
      }
      injectExplicitDagEngine(core, pi);
    } catch (err) {
      pi.ui?.notify?.(`[DAG] Initialization failed: ${err.message}`, "error");
    }
  });

  // Issue 9: Clean up background agents on session shutdown
  pi.on("session_shutdown", async () => {
    if (pi._dagTaskManager) {
      pi._dagTaskManager.abortAll();
      pi._dagTaskManager = null;
    }
  });
}
