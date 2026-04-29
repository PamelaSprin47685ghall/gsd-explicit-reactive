import { getTaskIds, loadWaves } from "./waves.js";
import { loadWaveSize } from "./settings.js";
import { renderWaveDashboard } from "./ui.js";

const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function injectWavesPrompt(prompt, waveSize) {
  return prompt + `

## 🛑 CRITICAL: AGGRESSIVE FINE-GRAINED PARALLELISM (WAVES.json)

This slice overrides standard execution with **Strict Wave-Based Parallelism**. Your goal is to maximize concurrency.

### 🧠 The "Orthogonal Splitting" Rule
LLMs naturally write sequential plans. **BREAK THIS HABIT.**
- If Task B touches different files/components than Task A, they belong in the **SAME WAVE**.
- Only place Task B in Wave N+1 if it *literally cannot be compiled/run* without Task A's output.

### 📝 WAVES.json Definition
Create \`.gsd/milestones/\${milestoneId}/slices/\${sliceId}/WAVES.json\`. Map Task IDs to wave integers (1 = first, 2 = second).
Concurrent capacity per wave: **${waveSize}**. Fill it up! Do NOT output a linear 1-by-1 plan.

Example \`WAVES.json\`:
\`\`\`json
{
  "T01": 1,
  "T02": 1,
  "T03": 2
}
\`\`\`
*(Here, T01 and T02 run concurrently in isolated sandboxes. T03 waits.)*
`;
}

function buildCombinedEnforcerExecutor(core, capturedCtx, waveSize) {
  return async (ctx) => {
    const { state, mid, midTitle, basePath, sessionContextWindow, modelRegistry } = ctx;
    if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;

    const sid = state.activeSlice.id;
    const sTitle = state.activeSlice.title;
    const dbModule = core["gsd-db"];
    const promptsModule = core["auto-prompts"];
    const prefsModels = core["preferences-models"];
    const reactiveGraph = core["reactive-graph"];

    const subagentModel = prefsModels?.resolveModelWithFallbacksForUnit?.("subagent")?.primary;

    const allTaskIds = getTaskIds(basePath, mid, sid, dbModule);
    if (allTaskIds.length === 0) return null;

    // ----------------------------------------------------
    // STAGE 1: THE ENFORCER (Strict Validation)
    // ----------------------------------------------------
    const wavePlan = loadWaves(basePath, mid, sid, allTaskIds);
    let errorReason = wavePlan.ok ? null : wavePlan.reason;

    if (wavePlan.ok && allTaskIds.length > 3) {
      const waveNums = Object.values(wavePlan.waves);
      const uniqueWaves = new Set(waveNums).size;
      const avgTasks = allTaskIds.length / uniqueWaves;
      if (avgTasks < 1.5) {
        errorReason = `Fake Concurrency Detected! ${allTaskIds.length} tasks spread across ${uniqueWaves} waves (avg ${avgTasks.toFixed(1)} tasks/wave). Redistribute tasks so each wave averages >= 1.5 tasks. Max capacity per wave is ${waveSize}.`;
      }
    }

    if (errorReason) {
      capturedCtx?.ui?.notify?.(`WAVES.json rejected: ${errorReason}`, "warning");
      if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);

      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: `# 🚨 RESTRUCTURE REQUIRED: Invalid or Sequential WAVES.json\n\n**Root Error:** ${errorReason}\n\nYou completely failed the concurrency requirement. You MUST REDESIGN the task breakdown and rewrite \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\`.\n\n- **Smash tasks together:** Combine independent tasks into the SAME WAVE.\n- **Capacity:** You have a capacity of **${waveSize}** tasks per wave. Use it.\n- **Rule:** Do not give me a linear 1-by-1 plan.\n\nCall \`gsd_plan_slice\` with your highly-parallel restructured plan.`
      };
    }

    // ----------------------------------------------------
    // STAGE 2: THE EXECUTOR (True Parallel Dispatch)
    // ----------------------------------------------------
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

    const incompleteTasks = [...statusMap.running, ...statusMap.unstarted];
    incompleteTasks.sort((a, b) => a.wave - b.wave);
    const activeWave = incompleteTasks[0].wave;

    const eligibleToStart = statusMap.unstarted.filter(t => t.wave === activeWave).map(t => t.id);
    if (eligibleToStart.length === 0) return null;

    const runningInActiveWave = statusMap.running.filter(t => t.wave === activeWave).length;
    if (runningInActiveWave >= waveSize) return null;

    const batchSize = Math.min(eligibleToStart.length, waveSize - runningInActiveWave);
    const selectedTasks = eligibleToStart.slice(0, batchSize).sort(TASK_COLLATOR.compare);
    if (selectedTasks.length === 0) return null;

    const totalWaves = [...new Set(Object.values(wavePlan.waves))].length;
    const dashboardMd = renderWaveDashboard(activeWave, totalWaves, waveSize, statusMap);
    capturedCtx?.ui?.notify?.(dashboardMd, "info");

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

export function patchDispatchRules(core, pi, capturedCtx) {
  const autoDispatchModule = core["auto-dispatch"];
  const registryModule = core["rule-registry"];
  const waveSize = loadWaveSize(capturedCtx);

  const rawRules = autoDispatchModule?.DISPATCH_RULES || [];

  let unifiedRules = [];
  if (registryModule) {
    try {
      const registry = registryModule.getRegistry();
      unifiedRules = registry.listRules().filter(r => r.when === "dispatch");
    } catch {}
  }

  const allRules = [...rawRules, ...unifiedRules];

  // Hook 1: Patch planning & refining to inject prompt
  for (const ruleName of ["planning → plan-slice", "refining → refine-slice"]) {
    const matchingRules = allRules.filter(r => r.name.includes(ruleName));
    for (const rule of matchingRules) {
      if (rule._wavesPatched) continue;

      const isUnified = "where" in rule;
      const originalFn = isUnified ? rule.where : rule.match;

      const newFn = async (...args) => {
        const result = await originalFn(...args);
        if (result && result.action === "dispatch" && result.prompt) {
          result.prompt = injectWavesPrompt(result.prompt, waveSize);
        }
        return result;
      };

      if (isUnified) rule.where = newFn;
      else rule.match = newFn;

      rule._wavesPatched = true;
    }
  }

  // Hook 2: Hijack the execution rule by overwriting its match/where closure
  const execRules = allRules.filter(r =>
    r.name.includes("executing → reactive-execute") || r.name.includes("executing → execute-task")
  );

  for (const rule of execRules) {
    if (rule._wavesPatched) continue;

    const combinedFn = buildCombinedEnforcerExecutor(core, capturedCtx, waveSize);

    const isUnified = "where" in rule;
    if (isUnified) rule.where = combinedFn;
    else rule.match = combinedFn;

    rule.name = "executing → explicit-reactive-waves (enforced)";
    rule._wavesPatched = true;
  }
}
