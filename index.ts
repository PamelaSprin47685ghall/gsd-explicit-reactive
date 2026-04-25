import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function (pi: ExtensionAPI) {
  // 1. 动态加载 GSD 内部模块 (健壮性增强：多路径探测 + JS/TS 自动识别)
  const possiblePaths = [
    process.env.GSD_CODING_AGENT_DIR ? join(process.env.GSD_CODING_AGENT_DIR, 'extensions', 'gsd') : null,
    process.env.GSD_PKG_ROOT ? join(process.env.GSD_PKG_ROOT, 'dist/resources/extensions/gsd') : null,
    process.env.GSD_PKG_ROOT ? join(process.env.GSD_PKG_ROOT, 'src/resources/extensions/gsd') : null,
    '../gsd'
  ].filter(Boolean) as string[];

  let gsdCorePath = "";
  for (const p of possiblePaths) {
    if (existsSync(join(p, "auto-dispatch.js")) || existsSync(join(p, "auto-dispatch.ts"))) {
      gsdCorePath = p;
      break;
    }
  }

  if (!gsdCorePath) {
    process.stderr.write("[Wave Optimizer] Error: Could not find GSD core extension directory.\n");
    return;
  }

  const getModulePath = (name: string) => {
    const jsPath = join(gsdCorePath, `${name}.js`);
    const tsPath = join(gsdCorePath, `${name}.ts`);
    return existsSync(jsPath) ? jsPath : tsPath;
  };

  const importModule = async (name: string) => {
    const p = getModulePath(name);
    return await import(pathToFileURL(p).href);
  };

  let autoDispatch, filesModule, dbModule, promptsModule, reactiveGraph, prefsModels;
  try {
    autoDispatch = await importModule("auto-dispatch");
    filesModule = await importModule("files");
    dbModule = await importModule("gsd-db");
    promptsModule = await importModule("auto-prompts");
    reactiveGraph = await importModule("reactive-graph");
    prefsModels = await importModule("preferences-models");
  } catch (err) {
    process.stderr.write(`[Wave Optimizer] Error loading core modules: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const DISPATCH_RULES = autoDispatch.DISPATCH_RULES;

  // =====================================================================
  // 规则 1：波次优化强制关卡 (Wave Optimization Gate)
  // 无视 PREFERENCES.md，强行开启拦截！
  // =====================================================================
  const enforceWaveBreakdownRule = {
    name: "executing → enforce-wave-breakdown",
    match: async ({ state, mid, basePath }: any) => {
      // 只要是 executing 阶段，不管用户配没配置 reactive，全盘接管！
      if (state.phase !== "executing" || !state.activeSlice) return null;
      
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
      
      let files: string[] = [];
      try {
        files = readdirSync(tasksDir).filter(f => f.endsWith("-PLAN.md"));
      } catch { 
        return null; 
      }

      // 强行检查所有任务是否都分配了 wave
      let needsOptimization = false;
      for (const file of files) {
        const content = readFileSync(join(tasksDir, file), "utf-8");
        const [fm] = filesModule.splitFrontmatter(content);
        const meta = fm ? filesModule.parseFrontmatterMap(fm) : {};
        
        // 核心检查：必须存在 wave 字段
        if (meta.wave === undefined || isNaN(Number(meta.wave))) {
          needsOptimization = true;
          break;
        }
      }

      if (!needsOptimization) return null; // 已经优化过，放行

      process.stderr.write(`\n[Wave Optimizer] Intercepted ${mid}/${sid}. Forcing uniform wave-based breakdown.\n`);

      return {
        action: "dispatch",
        unitType: "custom-step",
        unitId: `${mid}/${sid}/optimize-waves`,
        prompt: `## Wave-Based Execution Optimization (CRITICAL)

You are about to execute slice \`${sid}: ${sTitle}\`. However, the current task plan is not optimized for our execution engine.

**ENGINE CONSTRAINTS (Bulk Synchronous Parallel):**
Our engine executes tasks in synchronous "waves". It dispatches a batch of tasks simultaneously and **waits for ALL of them to finish** before moving to the next wave.
If you put one massive task and two tiny tasks in the same wave, the tiny tasks will finish in seconds, and the engine will sit completely idle waiting for the massive task to finish.

**Your Mission:**
1. **Uniform Task Sizing:** You MUST break down the current coarse tasks in \`${sid}-PLAN.md\` into smaller sub-tasks that are **roughly EQUAL in estimated execution time and complexity**.
2. **Wave Assignment:** Group independent tasks that can be safely executed in parallel into the same wave. 
3. **Rewrite Files:** Use the \`write\` or \`edit\` tools to rewrite \`${sid}-PLAN.md\` and the \`tasks/Txx-PLAN.md\` files to reflect this new uniform architecture.
4. **The Proof Marker:** For EVERY \`Txx-PLAN.md\` file, you MUST inject a \`wave: <number>\` field into its YAML frontmatter.
   - Example format for a task in the first batch:
     \`\`\`yaml
     ---
     wave: 1
     ---
     \`\`\`
   - Tasks in \`wave: 2\` will only start after ALL tasks in \`wave: 1\` are completely finished.

Do NOT start executing the actual code/tasks yet. Only redesign the plan into uniform waves, rewrite the markdown files, and complete your turn.`,
      };
    }
  };

  // =====================================================================
  // 规则 2：纯波次执行引擎 (Pure Wave-Based Engine)
  // 无视 PREFERENCES.md，强行启动 8 线程并发！
  // =====================================================================
  const waveReactiveRule = {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }: any) => {
      if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      
      // 🧨 暴力美学：强行写死 8 并发！完全不看用户配置！
      const maxParallel = 8;
      
      // 仍然允许用户在 PREFERENCES 里指定 subagent_model 用便宜模型，如果没有就用默认的
      const subagentModel = prefs?.reactive_execution?.subagent_model ?? prefsModels.resolveModelWithFallbacksForUnit("subagent")?.primary;

      const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
      let files: string[] = [];
      try { 
        files = readdirSync(tasksDir).filter(f => f.endsWith("-PLAN.md")); 
      } catch { 
        return null; 
      }

      const completed = new Set<string>();
      const pendingTasks: Array<{ id: string, wave: number }> = [];

      for (const file of files) {
        const tid = file.replace("-PLAN.md", "");
        const content = readFileSync(join(tasksDir, file), "utf-8");
        const [fm] = filesModule.splitFrontmatter(content);
        const meta = fm ? filesModule.parseFrontmatterMap(fm) : {};

        let wave = Number(meta.wave);
        if (isNaN(wave)) wave = 999; 

        let done = false;
        if (dbModule.isDbAvailable()) {
          const dbTask = dbModule.getTask(mid, sid, tid);
          if (dbTask && (dbTask.status === "complete" || dbTask.status === "done")) {
            done = true;
          }
        }

        if (done) {
          completed.add(tid);
        } else {
          pendingTasks.push({ id: tid, wave });
        }
      }

      if (pendingTasks.length === 0) return null;

      const minWave = Math.min(...pendingTasks.map(t => t.wave));

      const currentWaveIds = pendingTasks
        .filter(t => t.wave === minWave)
        .map(t => t.id)
        .sort();

      if (currentWaveIds.length <= 1) return null; 

      const selected = currentWaveIds.slice(0, maxParallel);

      process.stderr.write(`\n[Wave Optimizer] ${mid}/${sid} Wave ${minWave} Ready: ${currentWaveIds.length} | Dispatching: ${selected.join(",")} (Forced 8 Parallel)\n`);

      reactiveGraph.saveReactiveState(basePath, mid, sid, {
        sliceId: sid,
        completed: [...completed],
        dispatched: selected,
        graphSnapshot: { 
          taskCount: pendingTasks.length + completed.size, 
          edgeCount: 0, 
          readySetSize: currentWaveIds.length, 
          ambiguous: false 
        },
        updatedAt: new Date().toISOString(),
      });

      const batchSuffix = selected.join(",");
      return {
        action: "dispatch",
        unitType: "reactive-execute",
        unitId: `${mid}/${sid}/reactive+${batchSuffix}`,
        prompt: await promptsModule.buildReactiveExecutePrompt(
          mid, midTitle, sid, sTitle, selected, basePath, subagentModel,
          { sessionContextWindow, modelRegistry }
        ),
      };
    }
  };

  // =====================================================================
  // 挂载补丁 (Monkey-Patching)
  // =====================================================================
  const oldRuleIndex = DISPATCH_RULES.findIndex((r: any) => r.name === "executing → reactive-execute (parallel dispatch)");
  
  if (oldRuleIndex !== -1) {
    DISPATCH_RULES[oldRuleIndex] = waveReactiveRule;
    DISPATCH_RULES.splice(oldRuleIndex, 0, enforceWaveBreakdownRule);
    
    // 启动日志
    process.stderr.write("[Wave Optimizer] Loaded. Forced 8-thread Wave Parallelism ENABLED! Ignoring PREFERENCES.md.\n");
  } else {
    process.stderr.write("[Wave Optimizer] Failed to find target rule. GSD version mismatch?\n");
  }
}
