import { loadGsdCore } from "./src/discovery.js";
import { injectExplicitWavesEngine } from "./src/engine.js";

let engineInjected = false;
let currentWaveSize = 8;

export default async function explicitReactivePlugin(pi) {
  pi.on("session_start", async (_event, captureCtx) => {
    if (engineInjected) return;

    try {
      const core = await loadGsdCore();
      if (core) {
        injectExplicitWavesEngine(core, captureCtx, () => currentWaveSize);
        engineInjected = true;
      }
    } catch (err) {
      pi.ui?.notify?.(`[Explicit Waves] 初始化失败: ${err.message}`, "error");
    }
  });

  pi.registerCommand("wave-size", {
    description: "设置或查看当前的最大并行波次限制 (e.g. /wave-size 5)",
    handler: async (args, cmdCtx) => {
      if (args.length > 0) {
        const size = parseInt(args[0], 10);
        if (!isNaN(size) && size > 0) {
          currentWaveSize = size;
          cmdCtx.ui?.notify?.(`✅ Explicit Waves: 并发上限已修改为 ${size}`, "success");
        } else {
          cmdCtx.ui?.notify?.(`❌ 无效的并发数: ${args[0]}`, "error");
        }
      } else {
        cmdCtx.ui?.notify?.(`🌊 当前并发上限: ${currentWaveSize} 个任务/波次`, "info");
      }
    }
  });
}
