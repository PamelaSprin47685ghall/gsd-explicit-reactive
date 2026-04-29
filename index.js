import { loadGsdCoreModules } from "./src/discovery.js";
import { patchDispatchRules } from "./src/patch.js";
import { loadWaveSize, saveWaveSize } from "./src/settings.js";
import { getTaskIds, loadWaves } from "./src/waves.js";
import { renderWaveDashboard } from "./src/ui.js";

let patched = false;

export default async function explicitReactivePlugin(pi, ctx) {
  try {
    const core = await loadGsdCoreModules(ctx);
    if (core && !patched) {
      patched = true;
      patchDispatchRules(core, pi, ctx);
    }
  } catch {}

  pi.on("session_start", async (_event, captureCtx) => {
    if (patched) return;
    try {
      const core = await loadGsdCoreModules(captureCtx);
      if (core) {
        patched = true;
        patchDispatchRules(core, pi, captureCtx);
      }
    } catch (err) {
      captureCtx?.ui?.notify?.(`Init failed: ${err.message}`, "error");
    }
  });

  pi.registerCommand("wave-size", {
    description: "Set maximum parallel task wave size (e.g. /wave-size 8)",
    handler: async (args, cmdCtx) => {
      if (args.length > 0) {
        const size = parseInt(args[0], 10);
        if (!isNaN(size) && size > 0) {
          if (saveWaveSize(size, cmdCtx)) {
            cmdCtx.ui?.notify(`✅ Wave capacity set to: ${size}`, "success");
          }
        } else {
          cmdCtx.ui?.notify(`Invalid number: ${args[0]}`, "error");
        }
      } else {
        cmdCtx.ui?.notify(`Current wave capacity: ${loadWaveSize(cmdCtx)}`, "info");
      }
    }
  });

  pi.registerCommand("wave-status", {
    description: "Display the current wave execution dashboard",
    handler: async (args, cmdCtx) => {
      try {
        const core = await loadGsdCoreModules(cmdCtx);
        if (!core) return;

        const dbModule = core["gsd-db"];
        if (!dbModule || !dbModule.isDbAvailable()) {
          cmdCtx.ui?.notify("Database unavailable.", "warning");
          return;
        }

        const stateModule = core["state"];
        const state = await stateModule.deriveState(process.cwd());
        if (!state?.activeSlice) {
          cmdCtx.ui?.notify("No active slice running.", "info");
          return;
        }

        const mid = state.activeMilestone.id;
        const sid = state.activeSlice.id;
        const allTaskIds = getTaskIds(process.cwd(), mid, sid, dbModule);
        const wavePlan = loadWaves(process.cwd(), mid, sid, allTaskIds);

        if (!wavePlan.ok) {
          cmdCtx.ui?.notify(`WAVES.json invalid: ${wavePlan.reason}`, "error");
          return;
        }

        const waveSize = loadWaveSize(cmdCtx);
        cmdCtx.ui?.notify(`WAVES loaded successfully. Concurrency: ${waveSize}`, "info");
      } catch {}
    }
  });
}
