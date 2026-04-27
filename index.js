import { loadGsdCoreModules } from "./src/discovery.js";
import { patchDispatchRules } from "./src/patch.js";
import { loadWaveSize, saveWaveSize } from "./src/settings.js";

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
        capturedCtx?.ui?.notify?.(
          "Missing @gsd/pi-coding-agent — explicit-reactive dispatch disabled.", "error"
        );
        return;
      }
      patchDispatchRules(core, pi, capturedCtx);
    } catch (err) {
      capturedCtx?.ui?.notify?.(`Init failed: ${err.message}`, "error");
    }
  });

  pi.registerCommand("wave-size", {
    description: "Set maximum parallel task wave size",
    handler: async (args, ctx) => {
      if (args.length > 0) {
        const size = parseInt(args[0], 10);
        if (!isNaN(size) && size > 0) {
          saveWaveSize(size);
          ctx.ui?.notify(`wave-size: ${size}`, "info");
        } else {
          ctx.ui?.notify(`wave-size: invalid ${args[0]}`, "error");
        }
      } else {
        ctx.ui?.notify(`wave-size: ${loadWaveSize()}. Usage: /wave-size <number>`, "info");
      }
    }
  });
}
