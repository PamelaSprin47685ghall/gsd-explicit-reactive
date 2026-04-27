import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const PLUGIN_NAME = "gsd-explicit-reactive";
let FORCED_MAX_PARALLEL = 8;
const SETTINGS_PATH = path.join(os.homedir(), ".gsd", "explicit-reactive.json");

try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    if (data.waveSize) FORCED_MAX_PARALLEL = data.waveSize;
  }
} catch (e) {}

function saveSettings() {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ waveSize: FORCED_MAX_PARALLEL }));
  } catch (e) {}
}

const REQUIRED_MODULES = ["auto-dispatch", "gsd-db", "auto-prompts", "reactive-graph"];
const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

async function loadGsdCoreModules(ctx) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Resolve via @gsd/pi-coding-agent package — works regardless of install location
    null,
    process.env.GSD_CODING_AGENT_DIR ? path.join(process.env.GSD_CODING_AGENT_DIR, "extensions", "gsd") : null,
    process.env.GSD_PKG_ROOT ? path.join(process.env.GSD_PKG_ROOT, "dist", "resources", "extensions", "gsd") : null,
    process.env.GSD_PKG_ROOT ? path.join(process.env.GSD_PKG_ROOT, "src", "resources", "extensions", "gsd") : null,
    path.join(extensionDir, "..", "gsd", "dist", "resources", "extensions", "gsd"),
    path.join(extensionDir, "..", "gsd", "src", "resources", "extensions", "gsd"),
    path.join(extensionDir, "..", "gsd-2", "dist", "resources", "extensions", "gsd"),
    path.join(extensionDir, "..", "gsd-2", "src", "resources", "extensions", "gsd"),
    path.join(process.cwd(), "gsd-2", "dist", "resources", "extensions", "gsd"),
    path.join(process.cwd(), "gsd-2", "src", "resources", "extensions", "gsd"),
  ].filter(Boolean);

  // Resolve @gsd/pi-coding-agent to find bundled extensions path
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("@gsd/pi-coding-agent/package.json");
    const dir = path.join(path.dirname(pkgPath), "dist", "resources", "extensions", "gsd");
    candidates.unshift(dir);
  } catch {}

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let allFound = true;
    for (const mod of REQUIRED_MODULES) {
      if (!fs.existsSync(path.join(dir, `${mod}.js`)) && !fs.existsSync(path.join(dir, `${mod}.ts`))) {
        allFound = false; break;
      }
    }
    if (allFound) {
      const loaded = {};
      for (const mod of REQUIRED_MODULES) {
        const p = fs.existsSync(path.join(dir, `${mod}.js`)) ? path.join(dir, `${mod}.js`) : path.join(dir, `${mod}.ts`);
        loaded[mod] = await import(pathToFileURL(p).href);
      }
      return loaded;
    }
  }
  ctx?.ui?.notify(`[dispatch] Cannot locate GSD core modules. Searched:\n  ${candidates.join("\n  ")}`, "error");
  return null;
}

function getTaskIds(basePath, mid, sid) {
  const dir = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith("-PLAN.md"))
    .map(f => f.replace("-PLAN.md", ""))
    .sort(TASK_COLLATOR.compare);
}

function loadWaves(basePath, mid, sid, allTaskIds) {
  const waveFile = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "WAVES.json");
  if (!fs.existsSync(waveFile)) return { ok: false, reason: "WAVES.json is missing" };
  
  let waves;
  try {
    waves = JSON.parse(fs.readFileSync(waveFile, "utf-8"));
  } catch (err) {
    return { ok: false, reason: "WAVES.json contains malformed JSON" };
  }
  
  const definedTasks = new Set(Object.keys(waves));
  const missing = allTaskIds.filter(id => !definedTasks.has(id));
  const unknown = Object.keys(waves).filter(id => !allTaskIds.includes(id));
  
  if (missing.length > 0 || unknown.length > 0) {
    const detail = [];
    if (missing.length > 0) detail.push(`Missing: ${missing.join(",")}`);
    if (unknown.length > 0) detail.push(`Unknown: ${unknown.join(",")}`);
    return { ok: false, reason: `Task mismatch. ${detail.join(". ")}` };
  }
  
  for (const id of allTaskIds) {
    if (typeof waves[id] !== "number" || !Number.isInteger(waves[id]) || waves[id] < 1) {
      return { ok: false, reason: `Task ${id} has invalid wave number. Must be a positive integer.` };
    }
  }
  
  return { ok: true, waves };
}

// ---------------------------------------------------------------------------
// Patch logic extracted so it can be called lazily once ctx is available
// ---------------------------------------------------------------------------
function patchDispatchRules(core, pi, capturedCtx) {
  const DISPATCH_RULES = core["auto-dispatch"].DISPATCH_RULES;

  if (!Array.isArray(DISPATCH_RULES)) {
    capturedCtx?.ui?.notify?.("[dispatch] DISPATCH_RULES is not an array — cannot patch", "error");
    return;
  }

  const originalPlanRuleIdx = DISPATCH_RULES.findIndex(r => r.name === "planning → plan-slice");
  if (originalPlanRuleIdx !== -1) {
    const originalRule = DISPATCH_RULES[originalPlanRuleIdx];
    DISPATCH_RULES[originalPlanRuleIdx] = {
      ...originalRule,
      match: async (args) => {
        const result = await originalRule.match(args);
        if (!result) return null;
        
        const { mid, state } = args;
        const sid = state.activeSlice.id;
        
        result.prompt += `\n\n---\n\n## Explicit Task Waves Required\nDo NOT use "wave" frontmatter in individual Txx-PLAN.md files. Instead, you MUST create exactly one file at \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\` with the following structure:\n\`\`\`json\n{\n  "T01": 1,\n  "T02": 1,\n  "T03": 2\n}\n\`\`\`\nAssign positive integers. Tasks in the same wave will run concurrently. Maximum concurrency is ${FORCED_MAX_PARALLEL}.`;
        return result;
      }
    };
  }
  
  const reactiveRuleIndex = DISPATCH_RULES.findIndex(r => r.name.includes("reactive-execute (parallel dispatch)"));
  if (reactiveRuleIndex !== -1) {
    DISPATCH_RULES.splice(reactiveRuleIndex, 1);
    
    const dbModule = core["gsd-db"];
    const promptsModule = core["auto-prompts"];
    const reactiveGraph = core["reactive-graph"];
    const prefsModels = core["preferences-models"];
    
    const enforceWaveBreakdownRule = {
      name: "executing → enforce-explicit-waves",
      match: async ({ state, mid, basePath }) => {
        if (state.phase !== "executing" || !state.activeSlice) return null;
        const sid = state.activeSlice.id;
        
        const allTaskIds = getTaskIds(basePath, mid, sid);
        const wavePlan = loadWaves(basePath, mid, sid, allTaskIds);
        
        if (wavePlan.ok) return null; 
        
        capturedCtx?.ui?.notify(`[dispatch] Wave sidecar invalid: ${wavePlan.reason}. Triggering repair prompt.`, "warning");
        
        if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);

        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId: `${mid}/${sid}`,
          prompt: `# Repair explicit task waves sidecar\n\nYour WAVES.json file is invalid or missing.\nReason: ${wavePlan.reason}\n\nYou MUST create or fix \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\` before any task can execute. It must be a simple JSON object mapping every planned task ID to an integer wave number. Example:\n\`\`\`json\n{\n  "T01": 1,\n  "T02": 1,\n  "T03": 2\n}\n\`\`\`\nDo NOT recreate task plans, just fix the WAVES.json file.`
        };
      }
    };
    
    const waveReactiveRule = {
      name: "executing → explicit-reactive-execute (parallel dispatch)",
      match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }) => {
        if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;
        if (!prefs?.reactive_execution?.enabled) return null;
        
        const sid = state.activeSlice.id;
        const sTitle = state.activeSlice.title;
        const subagentModel = prefs?.reactive_execution?.subagent_model ?? prefsModels?.resolveModelWithFallbacksForUnit?.("subagent")?.primary;
        
        const allTaskIds = getTaskIds(basePath, mid, sid);
        const wavePlan = loadWaves(basePath, mid, sid, allTaskIds);
        if (!wavePlan.ok) {
          if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);
          return null;
        }
        
        const dbAvailable = typeof dbModule?.isDbAvailable === "function" && dbModule.isDbAvailable();
        const completed = new Set();
        const pending = [];
        
        for (const tid of allTaskIds) {
          let done = false;
          if (dbAvailable && typeof dbModule?.getTask === "function") {
            const dbTask = dbModule.getTask(mid, sid, tid);
            if (dbTask && ["complete", "done", "skipped"].includes(dbTask.status)) done = true;
          }
          if (done) {
            completed.add(tid);
          } else {
            pending.push({ id: tid, wave: wavePlan.waves[tid] });
          }
        }
        
        if (pending.length === 0) {
          if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);
          return null;
        }
        
        pending.sort((a, b) => a.wave - b.wave || TASK_COLLATOR.compare(a.id, b.id));
        const minWave = pending[0].wave;
        const currentWaveIds = pending.filter(t => t.wave === minWave).map(t => t.id);
        
        if (currentWaveIds.length <= 1) {
          if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);
          return null; 
        }
        
        const selected = currentWaveIds.slice(0, FORCED_MAX_PARALLEL);
        capturedCtx?.ui?.notify(`[dispatch] Triggering wave ${minWave} with ${selected.length} tasks (max ${FORCED_MAX_PARALLEL}).`, "info");
        
        const unitId = `${mid}/${sid}/reactive+${selected.join(",")}`;
        
        if (reactiveGraph?.saveReactiveState) {
          reactiveGraph.saveReactiveState(basePath, mid, sid, {
            sliceId: sid,
            completed: Array.from(completed),
            dispatched: selected,
            graphSnapshot: { taskCount: allTaskIds.length, edgeCount: 0, readySetSize: currentWaveIds.length, ambiguous: false },
            updatedAt: new Date().toISOString()
          });
        }
        
        return {
          action: "dispatch",
          unitType: "reactive-execute",
          unitId,
          prompt: await promptsModule.buildReactiveExecutePrompt(
            mid, midTitle, sid, sTitle, selected, basePath, subagentModel, { sessionContextWindow, modelRegistry }
          )
        };
      }
    };

    try {
      DISPATCH_RULES.splice(reactiveRuleIndex, 0, enforceWaveBreakdownRule, waveReactiveRule);
    } catch (err) {
      capturedCtx?.ui?.notify?.(
        `[dispatch] Failed to inject reactive dispatch rules: ${err.message}`, "error"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin default export — synchronous, lazy-init
// ---------------------------------------------------------------------------
export default function registerExplicitReactiveDispatch(pi) {
  let capturedCtx = null;
  let patched = false;

  pi.on("session_start", async (_, ctx) => {
    capturedCtx = ctx;
    if (patched) return;
    patched = true;

    try {
      const core = await loadGsdCoreModules(capturedCtx);
      if (!core) {
        capturedCtx?.ui?.notify?.(
          "[dispatch] Cannot locate GSD core modules — explicit-reactive dispatch disabled. " +
          "Ensure @gsd/pi-coding-agent is installed.", "error"
        );
        return;
      }
      patchDispatchRules(core, pi, capturedCtx);
    } catch (err) {
      capturedCtx?.ui?.notify?.(
        `[dispatch] Unexpected error during initialization: ${err.message}`, "error"
      );
    }
  });

  pi.registerCommand("wave-size", {
    description: "Set maximum parallel task wave size",
    handler: async (args, ctx) => {
      if (args.length > 0) {
        const size = parseInt(args[0], 10);
        if (!isNaN(size) && size > 0) {
          FORCED_MAX_PARALLEL = size;
          saveSettings();
          ctx.ui?.notify(`[dispatch] Wave size set to ${FORCED_MAX_PARALLEL}`, "info");
        } else {
          ctx.ui?.notify(`[dispatch] Invalid wave size: ${args[0]}`, "error");
        }
      } else {
        ctx.ui?.notify(`[dispatch] Current wave size is ${FORCED_MAX_PARALLEL}. Usage: /wave-size <number>`, "info");
      }
    }
  });
}
