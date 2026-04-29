import { loadGsdCoreModules } from "./src/discovery.js";
import { patchDispatchRules } from "./src/patch.js";
import { loadWaveSize, saveWaveSize } from "./src/settings.js";
import { getTaskIds, loadWaves } from "./src/waves.js";
import { renderWaveDashboard } from "./src/ui.js";

let capturedCtx = null;
let patched = false;

export default function explicitReactivePlugin(pi) {
  pi.on("session_start", async (_event, ctx) => {
    capturedCtx = ctx;
    if (patched) return;
    patched = true;

    try {
      const core = await loadGsdCoreModules(capturedCtx);
      if (!core) {
        capturedCtx?.ui?.notify?.("Missing GSD core — explicit-reactive disabled.", "error");
        return;
      }
      patchDispatchRules(core, pi, capturedCtx);
    } catch (err) {
      capturedCtx?.ui?.notify?.(`Init failed: ${err.message}`, "error");
    }
  });

  pi.registerCommand("wave-size", {
    description: "Set maximum parallel task wave size (e.g. /wave-size 8)",
    handler: async (args, ctx) => {
      if (args.length > 0) {
        const size = parseInt(args[0], 10);
        if (!isNaN(size) && size > 0) {
          if (saveWaveSize(size, ctx)) {
            ctx.ui?.notify(`✅ Wave capacity set to: ${size}`, "success");
          }
        } else {
          ctx.ui?.notify(`Invalid number: ${args[0]}`, "error");
        }
      } else {
        ctx.ui?.notify(`Current wave capacity: ${loadWaveSize(ctx)}`, "info");
      }
    }
  });

  pi.registerCommand("wave-status", {
    description: "Display the current wave execution dashboard",
    handler: async (args, ctx) => {
      try {
        const core = await loadGsdCoreModules(ctx);
        const dbModule = core["gsd-db"];
        if (!dbModule || !dbModule.isDbAvailable()) {
          ctx.ui?.notify("Database unavailable, cannot show wave status.", "warning");
          return;
        }

        const state = core["auto-dispatch"]?.deriveState?.(process.cwd());
        if (!state?.activeSlice) {
          ctx.ui?.notify("No active slice running.", "info");
          return;
        }

        const mid = state.activeMilestone.id;
        const sid = state.activeSlice.id;
        const allTaskIds = getTaskIds(process.cwd(), mid, sid);
        const wavePlan = loadWaves(process.cwd(), mid, sid, allTaskIds);

        if (!wavePlan.ok) {
          ctx.ui?.notify(`WAVES.json is invalid: ${wavePlan.reason}`, "error");
          return;
        }

        const statusMap = { completed: [], running: [], unstarted: [] };
        for (const tid of allTaskIds) {
          const dbTask = dbModule.getTask(mid, sid, tid);
          const status = (dbTask?.status || "pending").toLowerCase();
          const waveNum = wavePlan.waves[tid];

          if (["complete", "done", "skipped", "success"].includes(status)) {
            statusMap.completed.push({ id: tid, wave: waveNum });
          } else if (["running", "in_progress", "active", "dispatched"].includes(status)) {
            statusMap.running.push({ id: tid, wave: waveNum });
          } else {
            statusMap.unstarted.push({ id: tid, wave: waveNum });
          }
        }

        const incomplete = [...statusMap.running, ...statusMap.unstarted]
          .sort((a, b) => a.wave - b.wave);
        const activeWave = incomplete.length > 0 ? incomplete[0].wave : 1;
        const totalWaves = new Set(allTaskIds.map(id => wavePlan.waves[id])).size;
        const waveSize = loadWaveSize(ctx);

        ctx.ui?.notify(renderWaveDashboard(activeWave, totalWaves, waveSize, statusMap), "info");
      } catch (err) {
        ctx.ui?.notify(`Failed to load wave status: ${err.message}`, "error");
      }
    }
  });
}
