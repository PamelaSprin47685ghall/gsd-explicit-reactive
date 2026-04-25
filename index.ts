import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export default async function registerExtension(pi: ExtensionAPI) {
  // 1. 动态加载 GSD 内部模块
  const autoDispatch = await import("../gsd/auto-dispatch.js");
  const filesModule = await import("../gsd/files.js");
  const dbModule = await import("../gsd/gsd-db.js");
  const promptsModule = await import("../gsd/auto-prompts.js");
  const reactiveGraph = await import("../gsd/reactive-graph.js");
  const prefsModels = await import("../gsd/preferences-models.js");

  const DISPATCH_RULES = autoDispatch.DISPATCH_RULES;

  // =====================================================================
  // 规则 1：强制并发重构关卡 (Concurrency Breakdown Gate)
  // 如果发现任何 Txx-PLAN.md 缺少 explicit `depends`，拒绝执行，
  // 强制 LLM 重新思考并拆分成适合并行的细粒度任务。
  // =====================================================================
  const enforceBreakdownRule = {
    name: "executing → enforce-explicit-dependencies",
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

      // 检查是否所有任务都有 depends 字段
      let needsOptimization = false;
      for (const file of files) {
        const content = readFileSync(join(tasksDir, file), "utf-8");
        const [fm] = filesModule.splitFrontmatter(content);
        const meta = fm ? filesModule.parseFrontmatterMap(fm) : {};
        
        if (meta.depends === undefined) {
          needsOptimization = true;
          break;
        }
      }

      if (!needsOptimization) return null; // 已经优化过，放行给并发引擎

      process.stderr.write(`\n[Explicit Reactive Plugin] Intercepted ${mid}/${sid}. Forcing fine-grained breakdown.\n`);

      // 拦截并派发强制重构任务
      return {
        action: "dispatch",
        unitType: "custom-step",
        unitId: `${mid}/${sid}/optimize-concurrency`,
        prompt: `## Parallel Task Breakdown Required (CRITICAL)

You are about to execute slice \`${sid}: ${sTitle}\`. However, the current task plan was likely generated sequentially and is too coarse-grained for efficient parallel execution.

To leverage the system's parallel reactive engine, you MUST completely refactor the task plan for this slice.

**Your Mission:**
1. **Deconstruct:** Break down the current coarse tasks in \`${sid}-PLAN.md\` into much smaller, highly cohesive, and decoupled sub-tasks.
2. **Maximize Concurrency:** Design the new tasks so that as many as possible can run simultaneously without file conflicts.
3. **Rewrite Files:** Use the \`write\` or \`edit\` tools to thoroughly update \`${sid}-PLAN.md\` and recreate the \`tasks/Txx-PLAN.md\` files to reflect your new fine-grained architecture.
4. **Explicit Dependencies:** Determine the strict execution order (e.g., T02 must wait for T01).
5. **The Proof Marker:** For EVERY \`Txx-PLAN.md\` file, you MUST inject a \`depends\` array into its YAML frontmatter. This is the system's proof that the task has been optimized.
   - Example format:
     \`\`\`yaml
     ---
     depends: [T01, T02]
     ---
     \`\`\`
   - If a task has no prerequisites and can run immediately, you MUST write \`depends: []\`.

Do NOT start executing the actual code/tasks yet. Only redesign the plan, rewrite the markdown files, and complete your turn.`,
      };
    }
  };

  // =====================================================================
  // 规则 2：显式并发调度引擎 (Robust Explicit DAG Engine)
  // 只认 YAML 里的 depends 构建执行图
  // =====================================================================
  const robustReactiveRule = {
    name: "executing → explicit-reactive-execute",
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
      const allTasks: Array<{ id: string, depends: string[], done: boolean }> = [];

      for (const file of files) {
        const tid = file.replace("-PLAN.md", "");
        const content = readFileSync(join(tasksDir, file), "utf-8");
        const [fm] = filesModule.splitFrontmatter(content);
        const meta = fm ? filesModule.parseFrontmatterMap(fm) : {};

        let depends: string[] = [];
        if (Array.isArray(meta.depends)) {
          depends = meta.depends.map(String).map(s => s.trim().toUpperCase());
        } else if (typeof meta.depends === "string") {
          depends = meta.depends.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
        }

        let done = false;
        if (dbModule.isDbAvailable()) {
          const dbTask = dbModule.getTask(mid, sid, tid);
          if (dbTask && (dbTask.status === "complete" || dbTask.status === "done")) {
            done = true;
          }
        }

        if (done) completed.add(tid);
        allTasks.push({ id: tid, depends, done });
      }

      // 根据显式的 depends 计算可以立即并发执行的任务
      const readyIds = allTasks
        .filter(t => !t.done && t.depends.every(d => completed.has(d)))
        .map(t => t.id)
        .sort();

      if (readyIds.length <= 1) return null; 

      const selected = readyIds.slice(0, maxParallel);
      process.stderr.write(`\n[Explicit Reactive Plugin] ${mid}/${sid} DAG Ready: ${readyIds.length} | Dispatching: ${selected.join(",")}\n`);

      reactiveGraph.saveReactiveState(basePath, mid, sid, {
        sliceId: sid,
        completed: [...completed],
        dispatched: selected,
        graphSnapshot: { taskCount: allTasks.length, edgeCount: 0, readySetSize: readyIds.length, ambiguous: false },
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
    DISPATCH_RULES[oldRuleIndex] = robustReactiveRule;
    DISPATCH_RULES.splice(oldRuleIndex, 0, enforceBreakdownRule);
    process.stderr.write("[Explicit Reactive Plugin] Loaded. Native reactive engine hijacked and breakdown gate added.\n");
  } else {
    process.stderr.write("[Explicit Reactive Plugin] Failed to find target rule. GSD version mismatch?\n");
  }
}
