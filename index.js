import { loadGsdCoreModules } from "./src/discovery.js";
import { patchDispatchRules } from "./src/patch.js";
import { loadWaveSize, saveWaveSize } from "./src/settings.js";
import { getTaskIds, loadWaves } from "./src/waves.js";
import { uiLog } from "./src/logger.js";

let patched = false;

export default async function explicitReactivePlugin(pi) {
  pi.on("session_start", async (_event, captureCtx) => {
    uiLog(captureCtx, "检测到 Session 启动，正在初始化 Explicit Waves 并发引擎...", "info");
    if (patched) return;
    try {
      const core = await loadGsdCoreModules(captureCtx);
      if (core) {
        patched = true;
        patchDispatchRules(core, captureCtx);
      }
    } catch (err) {
      uiLog(captureCtx, `初始化失败: ${err.message}`, "error");
    }
  });

  pi.registerCommand("wave-size", {
    description: "Set maximum parallel task wave size (e.g. /wave-size 8)",
    handler: async (args, cmdCtx) => {
      if (args.length > 0) {
        const size = parseInt(args[0], 10);
        if (!isNaN(size) && size > 0) {
          if (saveWaveSize(size, cmdCtx)) {
            uiLog(cmdCtx, `✅ 并发上限已设置为: ${size}`, "success");
          }
        } else {
          uiLog(cmdCtx, `无效数字: ${args[0]}`, "error");
        }
      } else {
        uiLog(cmdCtx, `当前并发上限: ${loadWaveSize(cmdCtx)}`, "info");
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
          uiLog(cmdCtx, "Database unavailable.", "warning");
          return;
        }

        const stateModule = core["state"];
        const state = await stateModule.deriveState(process.cwd());
        if (!state?.activeSlice) {
          uiLog(cmdCtx, "当前没有正在运行的 Slice", "info");
          return;
        }

        const mid = state.activeMilestone.id;
        const sid = state.activeSlice.id;
        const allTaskIds = getTaskIds(process.cwd(), mid, sid, dbModule);
        const wavePlan = loadWaves(cmdCtx, process.cwd(), mid, sid, allTaskIds);

        if (!wavePlan.ok) {
          uiLog(cmdCtx, `WAVES.json 无效: ${wavePlan.reason}`, "error");
          return;
        }
        uiLog(cmdCtx, `WAVES 正常，当前并发配置: ${loadWaveSize(cmdCtx)}`, "info");
      } catch (err) {
        uiLog(cmdCtx, `执行出错: ${err.message}`, "error");
      }
    }
  });
}
