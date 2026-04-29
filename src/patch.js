import { getTaskIds, loadWaves } from "./waves.js";
import { loadWaveSize } from "./settings.js";
import { renderWaveDashboard } from "./ui.js";
import { uiLog } from "./logger.js";
import fs from "node:fs";
import path from "node:path";

const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function injectWavesPrompt(prompt, waveSize, mid, sid) {
  return prompt + `

## 🛑 EXTREMELY CRITICAL: HIGH-CONCURRENCY WAVES REQUIRED 🛑

You MUST create a file at \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\`.
If you do not create this file, your plan will be REJECTED and you will be forced to replan.

**CONCURRENCY RULE:**
Group tasks into parallel execution "waves" (integers 1, 2, 3...).
- Max tasks per wave: ${waveSize}.
- If Task B does not absolutely require Task A's output to compile, put them in the SAME WAVE.
- DO NOT output a linear 1-by-1 plan. Maximize the number of tasks in Wave 1!

**FORMAT:**
\`\`\`json
{
  "T01": 1,
  "T02": 1,
  "T03": 2
}
\`\`\`
*(Here, T01 and T02 run concurrently. T03 waits for them to finish).*
`;
}

function buildCombinedEnforcerExecutor(core, allRules) {
  return async (ctx) => {
    const { state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, session } = ctx;
    if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;

    const sid = state.activeSlice.id;
    const waveSize = loadWaveSize(session?.cmdCtx || ctx);

    // 0. Yield to GSD-2 native recovery rule
    const firstTid = state.activeTask.id;
    const tasksDir = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir);
      if (!files.some(f => f.toUpperCase().startsWith(`${firstTid.toUpperCase()}-`))) return null;
    } else return null;

    const sTitle = state.activeSlice.title;
    const dbModule = core["gsd-db"];
    const promptsModule = core["auto-prompts"];
    const prefsModels = core["preferences-models"];
    const reactiveGraph = core["reactive-graph"];

    const subagentModel = prefsModels?.resolveModelWithFallbacksForUnit?.("subagent")?.primary;
    const allTaskIds = getTaskIds(basePath, mid, sid, dbModule);
    if (allTaskIds.length === 0) return null;

    // ==========================================
    // STAGE 1: ENFORCER (Strict Validation)
    // ==========================================
    const wavePlan = loadWaves(ctx, basePath, mid, sid, allTaskIds);
    let errorReason = wavePlan.ok ? null : wavePlan.reason;

    if (wavePlan.ok && allTaskIds.length >= 3) {
      const uniqueWaves = new Set(Object.values(wavePlan.waves)).size;
      const avgTasks = allTaskIds.length / uniqueWaves;
      if (avgTasks < 1.5) {
        errorReason = `Fake Concurrency: ${allTaskIds.length} tasks across ${uniqueWaves} waves. Group independent tasks into the SAME wave!`;
      }
    }

    if (errorReason) {
      uiLog(ctx, `WAVES 违规拦截: ${errorReason}. 正在提取完整上下文，强制打回重做!`, "error");
      if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);

      // Invoke the native plan-slice rule to build a full-context prompt
      const planRule = allRules.find(r => r.name.includes("planning → plan-slice"));
      if (planRule) {
        const originalPhase = state.phase;
        state.phase = "planning";
        const isUnified = "where" in planRule;
        const planResult = await (isUnified ? planRule.where(ctx) : planRule.match(ctx));
        state.phase = originalPhase;

        if (planResult && planResult.prompt) {
          planResult.prompt = `# 🚨 PLAN REJECTED: WAVES.json ERROR 🚨\n\n**Reason:** ${errorReason}\n\nYou MUST redesign the plan and create a highly concurrent WAVES.json.\n\n---\n\n` + planResult.prompt;
          return planResult;
        }
      }

      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: `# 🚨 CRITICAL REJECTION 🚨\n\nYour previous plan was rejected because: ${errorReason}\n\nYou MUST rewrite \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\`.`
      };
    }

    // ==========================================
    // STAGE 2: EXECUTOR (Parallel Dispatch)
    // ==========================================
    const statusMap = { completed: [], running: [], unstarted: [] };
    const dbAvailable = typeof dbModule?.isDbAvailable === "function" && dbModule.isDbAvailable();

    for (const tid of allTaskIds) {
      let status = "pending";
      if (dbAvailable) {
        const dbTask = dbModule.getTask(mid, sid, tid);
        if (dbTask && dbTask.status) status = dbTask.status.toLowerCase();
      }
      const waveNum = wavePlan.waves[tid];
      if (["complete", "done", "skipped", "success"].includes(status)) {
        statusMap.completed.push({ id: tid, wave: waveNum });
      } else if (["running", "in_progress", "active", "dispatched"].includes(status)) {
        statusMap.running.push({ id: tid, wave: waveNum });
      } else {
        statusMap.unstarted.push({ id: tid, wave: waveNum });
      }
    }

    if (statusMap.unstarted.length === 0) {
      if (statusMap.running.length === 0 && reactiveGraph?.clearReactiveState) {
        reactiveGraph.clearReactiveState(basePath, mid, sid);
      }
      return null;
    }

    const incompleteTasks = [...statusMap.running, ...statusMap.unstarted].sort((a, b) => a.wave - b.wave);
    const activeWave = incompleteTasks[0].wave;
    const eligibleToStart = statusMap.unstarted.filter(t => t.wave === activeWave).map(t => t.id);

    if (eligibleToStart.length === 0) {
      uiLog(ctx, `Wave ${activeWave} 的任务尚未全部完成，正在等待沙盒执行结束...`, "info");
      return null;
    }

    const runningInActiveWave = statusMap.running.filter(t => t.wave === activeWave).length;
    if (runningInActiveWave >= waveSize) return null;

    const batchSize = Math.min(eligibleToStart.length, waveSize - runningInActiveWave);
    const selectedTasks = eligibleToStart.slice(0, batchSize).sort(TASK_COLLATOR.compare);
    if (selectedTasks.length === 0) return null;

    const totalWaves = [...new Set(Object.values(wavePlan.waves))].length;
    const dashboardMd = renderWaveDashboard(activeWave, totalWaves, waveSize, statusMap);

    uiLog(ctx, `\n${dashboardMd}`, "success");
    uiLog(ctx, `🚀 正在派发 Wave ${activeWave} 任务: ${selectedTasks.join(", ")}`, "success");

    if (reactiveGraph?.saveReactiveState) {
      reactiveGraph.saveReactiveState(basePath, mid, sid, {
        sliceId: sid,
        completed: statusMap.completed.map(t => t.id),
        dispatched: selectedTasks,
        currentWave: activeWave,
        graphSnapshot: { taskCount: allTaskIds.length, edgeCount: 0, readySetSize: eligibleToStart.length, ambiguous: false },
        updatedAt: new Date().toISOString()
      });
    }

    const batchSuffix = selectedTasks.join(",");
    const unitId = `${mid}/${sid}/reactive+${batchSuffix}`;
    let basePrompt = await promptsModule.buildReactiveExecutePrompt(
      mid, midTitle, sid, sTitle, selectedTasks, basePath, subagentModel,
      { sessionContextWindow, modelRegistry }
    );

    const sandboxBlock = `\n\n## 🌊 SANDBOXED WAVE EXECUTION (Wave ${activeWave}/${totalWaves}) 🌊\n\nYou are orchestrating a parallel wave. You must invoke the \`subagent\` tool for EXACTLY the tasks listed. Instruct each subagent to STRICTLY isolate its work. DO NOT implement upcoming tasks to avoid Git conflicts.`;

    return {
      action: "dispatch",
      unitType: "reactive-execute",
      unitId,
      prompt: basePrompt + sandboxBlock,
    };
  };
}

export function patchDispatchRules(core, ctx) {
  const autoDispatchModule = core["auto-dispatch"];
  const registryModule = core["rule-registry"];

  const rawRules = autoDispatchModule?.DISPATCH_RULES || [];
  let unifiedRules = [];
  if (registryModule) {
    try {
      const registry = registryModule.getRegistry();
      unifiedRules = registry.listRules().filter(r => r.when === "dispatch");
    } catch {}
  }

  const allRules = [...rawRules, ...unifiedRules];
  let patchedCount = 0;

  // 1. Hook Planning & Refining (Injection)
  for (const ruleName of ["planning → plan-slice", "refining → refine-slice", "replanning-slice → replan-slice"]) {
    const matchingRules = allRules.filter(r => r.name.includes(ruleName));
    for (const rule of matchingRules) {
      if (rule._wavesPatched) continue;
      const isUnified = "where" in rule;
      const originalFn = isUnified ? rule.where : rule.match;

      const newFn = async (...args) => {
        const invokeCtx = args[0];
        const waveSize = loadWaveSize(invokeCtx.session?.cmdCtx || invokeCtx);
        const result = await originalFn(...args);
        if (result && result.action === "dispatch" && result.prompt) {
          uiLog(invokeCtx, `[Prompt Hook] 已向 ${rule.name} 注入高并发波次规则`, "success");
          result.prompt = injectWavesPrompt(result.prompt, waveSize, invokeCtx.mid, invokeCtx.state.activeSlice.id);
        }
        return result;
      };

      if (isUnified) rule.where = newFn; else rule.match = newFn;
      rule._wavesPatched = true;
      patchedCount++;
    }
  }

  // 2. Hook Execution (The Enforcer & Executor)
  const execRules = allRules.filter(r =>
    (r.name.includes("executing → reactive-execute") || r.name === "executing → execute-task") &&
    !r.name.includes("recover")
  );

  for (let i = 0; i < execRules.length; i++) {
    const rule = execRules[i];
    if (rule._wavesPatched) continue;
    const isUnified = "where" in rule;

    if (rule.name.includes("reactive-execute")) {
      uiLog(ctx, `[Hook] 接管并发执行引擎: ${rule.name}`, "info");
      const combinedFn = buildCombinedEnforcerExecutor(core, allRules);
      if (isUnified) rule.where = combinedFn; else rule.match = combinedFn;
      rule.name = "executing → explicit-reactive-waves (enforced)";
    } else {
      uiLog(ctx, `[Hook] 强制禁用了原生串行执行降级: ${rule.name}`, "warning");
      const nullFn = async () => null;
      if (isUnified) rule.where = nullFn; else rule.match = nullFn;
      rule.name = "executing → execute-task (DISABLED BY WAVES)";
    }
    rule._wavesPatched = true;
    patchedCount++;
  }

  if (patchedCount > 0) {
    uiLog(ctx, `成功注入 ${patchedCount} 个拦截探针! 系统目前由 Explicit Waves 全面接管。`, "success");
  }
}
