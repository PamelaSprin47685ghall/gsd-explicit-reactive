import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export default async function registerExtension(pi: ExtensionAPI) {
  // 1. 动态加载 GSD 内部模块
  // 假设扩展部署在 GSD 扩展目录下，可以通过相对路径访问核心模块
  const autoDispatch = await import("../gsd/auto-dispatch.js");
  const filesModule = await import("../gsd/files.js");
  const dbModule = await import("../gsd/gsd-db.js");
  const promptsModule = await import("../gsd/auto-prompts.js");
  const reactiveGraph = await import("../gsd/reactive-graph.js");
  const prefsModels = await import("../gsd/preferences-models.js");

  const DISPATCH_RULES = autoDispatch.DISPATCH_RULES;

  // =====================================================================
  // 规则 1：波次优化强制关卡 (Wave Optimization Gate)
  // 如果发现 Txx-PLAN.md 缺少 explicit `wave` 字段，拦截并强制重构。
  // =====================================================================
  const enforceWaveBreakdownRule = {
    name: "executing → enforce-wave-breakdown",
    match: async ({ state, mid, basePath, prefs }: any) => {
      if (state.phase !== "executing" || !state.activeSlice) return null;
      
      const reactiveConfig = prefs?.reactive_execution;
      if (!reactiveConfig?.enabled) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
      
      let files: string[] = [];
      try {
        files = readdirSync(tasksDir).filter(f => f.endsWith("-PLAN.md"));
      } catch { 
        return null; 
      }

      // 检查是否所有任务都分配了 wave
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
  // 只读取未完成任务中 wave 最小的一批，作为当前波次派发
  // =====================================================================
  const waveReactiveRule = {
    name: "executing → reactive-execute (parallel dispatch)", // 保持名字一样以便替换
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }: any) => {
      if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;

      const reactiveConfig = prefs?.reactive_execution;
      if (!reactiveConfig?.enabled) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const maxParallel = reactiveConfig.max_parallel ?? 2;
      const subagentModel = reactiveConfig.subagent_model ?? prefsModels.resolveModelWithFallbacksForUnit("subagent")?.primary;

      if (maxParallel <= 1) return null;

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
        if (isNaN(wave)) wave = 999; // 兜底容错

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

      // 找到当前未完成任务中，wave 最小的波次
      const minWave = Math.min(...pendingTasks.map(t => t.wave));

      // 筛选出属于当前波次的所有任务
      const currentWaveIds = pendingTasks
        .filter(t => t.wave === minWave)
        .map(t => t.id)
        .sort();

      // 如果当前波次只有 1 个任务，回退为原生单线执行（节省资源）
      if (currentWaveIds.length <= 1) return null; 

      // 受 max_parallel 限制，截取当前波次要派发的任务
      // (没选中的任务依然在这个 wave 里，等这批跑完下一回合继续取这批)
      const selected = currentWaveIds.slice(0, maxParallel);

      process.stderr.write(`\n[Wave Optimizer] ${mid}/${sid} Wave ${minWave} Ready: ${currentWaveIds.length} | Dispatching: ${selected.join(",")}\n`);

      // 写入状态，伪造一个 graphSnapshot 喂给原生健康检查
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
    // 替换原生的图计算派发器为纯波次派发器
    DISPATCH_RULES[oldRuleIndex] = waveReactiveRule;
    // 在派发前插入拦截器，强迫 LLM 切分波次和均匀化任务
    DISPATCH_RULES.splice(oldRuleIndex, 0, enforceWaveBreakdownRule);
    
    process.stderr.write("[Wave Optimizer] Loaded. Reactive engine replaced with uniform wave execution.\n");
  } else {
    process.stderr.write("[Wave Optimizer] Failed to find target rule. GSD version mismatch?\n");
  }
}
