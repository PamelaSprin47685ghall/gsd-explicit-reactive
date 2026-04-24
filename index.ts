import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default async function registerExtension(pi: ExtensionAPI) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // 1. 探测 GSD 核心扩展的安装路径
  const possibleCoreDirs = [
    join(__dirname, "..", "gsd"),                              // 同级 (gsd install 布局)
    join(__dirname, "..", "..", "extensions", "gsd"),          // 相对 git 缓存
    join(__dirname, "..", "..", "..", "extensions", "gsd"),       // 深度 git 缓存
    join(process.env.HOME || "", ".gsd/agent/extensions/gsd")   // 绝对路径 (自动获取 HOME)
  ];

  let coreDir = "";
  for (const dir of possibleCoreDirs) {
    if (existsSync(join(dir, "auto-dispatch.js"))) {
      coreDir = dir;
      break;
    }
  }

  if (!coreDir) {
    process.stderr.write("[Explicit Reactive] ERROR: Could not find GSD core extension directory.\n");
    return;
  }

  // 2. 动态导入核心模块 (使用绝对路径导入绕过相对路径解析问题)
  const autoDispatch = await import(join(coreDir, "auto-dispatch.js"));
  const filesModule = await import(join(coreDir, "files.js"));
  const dbModule = await import(join(coreDir, "gsd-db.js"));
  const promptsModule = await import(join(coreDir, "auto-prompts.js"));
  const reactiveGraph = await import(join(coreDir, "reactive-graph.js"));
  const prefsModels = await import(join(coreDir, "preferences-models.js"));

  const DISPATCH_RULES = autoDispatch.DISPATCH_RULES;

  // 规则 1：前置阻断与依赖修复 (如果发现缺少 explicit depends, 打回让 LLM 修正)
  const enforceDepsRule = {
    name: "executing → enforce-explicit-dependencies",
    match: async ({ state, mid, basePath, prefs }: any) => {
      if (state.phase !== "executing" || !state.activeSlice) return null;
      
      const reactiveConfig = prefs?.reactive_execution;
      if (!reactiveConfig?.enabled) return null;

      const sid = state.activeSlice.id;
      const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
      
      let files: string[] = [];
      try {
        files = readdirSync(tasksDir).filter(f => f.endsWith("-PLAN.md"));
      } catch { 
        return null; 
      }

      let needsFixing = false;
      for (const file of files) {
        const content = readFileSync(join(tasksDir, file), "utf-8");
        const [fm] = filesModule.splitFrontmatter(content);
        const meta = fm ? filesModule.parseFrontmatterMap(fm) : {};
        
        if (meta.depends === undefined) {
          needsFixing = true;
          break;
        }
      }

      if (!needsFixing) return null;

      return {
        action: "dispatch",
        unitType: "custom-step",
        unitId: `${mid}/${sid}/fix-dependencies`,
        prompt: `## Concurrency Optimization Required

Before executing slice \`${sid}\`, you must define explicit execution dependencies for its tasks.
The parallel reactive engine requires an explicit \`depends\` array in the YAML frontmatter of EVERY \`Txx-PLAN.md\` file.

**Instructions:**
1. Review all task plans in \`${sid}\`.
2. Determine strict execution order (e.g., T02 must wait for T01 to finish).
3. Use the \`edit\` tool to add \`depends: [T01]\` (or \`depends: []\` if no prerequisites) to the YAML frontmatter of EVERY task plan.
4. Do NOT over-constrain. If tasks can run in parallel, leave their dependencies empty or parallel.

**CRITICAL:** Do NOT start executing the actual tasks. Just update the YAML frontmatters, summarize that you added the dependencies, and complete this turn.`,
      };
    }
  };

  // 规则 2：显式并发调度引擎 (只认 YAML Frontmatter)
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

      const readyIds = allTasks
        .filter(t => !t.done && t.depends.every(d => completed.has(d)))
        .map(t => t.id)
        .sort();

      if (readyIds.length <= 1) return null;

      const selected = readyIds.slice(0, maxParallel);

      process.stderr.write(`\n[explicit-reactive] ${mid}/${sid} ready:${readyIds.length} dispatching:${selected.join(",")}\n`);

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

  // 挂载补丁
  const oldRuleIndex = DISPATCH_RULES.findIndex((r: any) => r.name === "executing → reactive-execute (parallel dispatch)");
  if (oldRuleIndex !== -1) {
    DISPATCH_RULES[oldRuleIndex] = robustReactiveRule;
    DISPATCH_RULES.splice(oldRuleIndex, 0, enforceDepsRule);
    process.stderr.write("[Explicit Reactive Plugin] Loaded. Native reactive engine hijacked.\n");
  }
}
