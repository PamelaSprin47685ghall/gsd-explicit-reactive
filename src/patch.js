import { getTaskIds, loadWaves } from "./waves.js";
import { loadWaveSize } from "./settings.js";
import { renderWaveDashboard } from "./ui.js";

// ==========================================
// 1. Plan Stage: Aggressive parallelism prompt injection
// ==========================================
function buildPlanSlicePatcher(waveSize) {
  return function patchPlanSlice(args) {
    const { mid, state } = args;
    const sid = state.activeSlice.id;
    args.prompt += `

## 🛑 CRITICAL: AGGRESSIVE FINE-GRAINED PARALLELISM (WAVES.json)

This slice overrides standard execution with **Strict Wave-Based Parallelism**. Your goal is to maximize concurrency by splitting work into perfectly isolated micro-tasks.

### 🧠 The "Orthogonal Splitting" Rule
LLMs naturally write sequential plans (Task 1 -> Task 2 -> Task 3). **BREAK THIS HABIT.**
- If Task B touches different files/components than Task A, they belong in the **SAME WAVE**.
- Only place Task B in Wave N+1 if it *literally cannot be compiled/run* without Task A's output.
- **Micro-Tasking:** "Build Dashboard" is bad. "Build Header", "Build Sidebar", "Build Chart" all in Wave 1 is EXACTLY what we want.

### 📝 WAVES.json Definition
Create \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\`. Map Task IDs to wave integers (1 = first, 2 = second).
Concurrent capacity per wave: **${waveSize}**. Fill it up!

\`\`\`json
{
  "T01": 1,
  "T02": 1,
  "T03": 1,
  "T04": 2
}
\`\`\`
*(Here, T01, T02, T03 run simultaneously in isolated sandboxes. T04 waits.)*`;
    return args;
  };
}

// ==========================================
// 2. Enforcer Stage: Anti-fake concurrency algorithm
// ==========================================
function buildEnforceWaveRule(waveSize, capturedCtx, reactiveGraph) {
  return {
    name: "executing → enforce-explicit-waves",
    match: async ({ state, mid, basePath }) => {
      if (state.phase !== "executing" || !state.activeSlice) return null;
      const sid = state.activeSlice.id;
      const allTaskIds = getTaskIds(basePath, mid, sid);
      const wavePlan = loadWaves(basePath, mid, sid, allTaskIds);

      let errorReason = wavePlan.ok ? null : wavePlan.reason;

      // Anti-Fake-Concurrency Check (only when format is valid AND there are enough tasks)
      if (wavePlan.ok && allTaskIds.length > 3) {
        const waveNumbers = Object.values(wavePlan.waves);
        const uniqueWaves = new Set(waveNumbers).size;
        const avgTasksPerWave = allTaskIds.length / uniqueWaves;

        // If average tasks per wave < 1.5, the LLM didn't design for true concurrency
        if (avgTasksPerWave < 1.5) {
          errorReason = `Fake Concurrency Detected! You have ${allTaskIds.length} tasks spread across ${uniqueWaves} waves (avg ${avgTasksPerWave.toFixed(1)} tasks/wave). This is essentially sequential execution — redistribute tasks so each wave averages ≥1.5 tasks. `;
        }
      }

      if (!errorReason) return null;

      capturedCtx?.ui?.notify(`WAVES.json rejected: ${errorReason}`, "warning");
      if (reactiveGraph?.clearReactiveState)
        reactiveGraph.clearReactiveState(basePath, mid, sid);

      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: `# 🚨 RESTRUCTURE REQUIRED: Invalid or Sequential WAVES.json

**Root Error:** ${errorReason}

You completely failed the concurrency requirement. You must REDESIGN the task breakdown.

### How to fix:
- **Smash tasks together:** Combine independent tasks into the SAME WAVE.
- **Decompose:** If a task is too big, split it into 3 smaller tasks and put them ALL in Wave 1.
- You have a capacity of **${waveSize}** tasks per wave. Use it. Do not give me a linear 1-by-1 plan.

Call \`gsd_plan_slice\` with your highly-parallel restructured plan.`
      };
    }
  };
}

// ==========================================
// 3. Execution Stage: True parallel dispatch + UI Dashboard
// ==========================================
function buildWaveReactiveRule(waveSize, capturedCtx, dbModule, promptsModule, reactiveGraph, prefsModels) {
  return {
    name: "executing → explicit-reactive-execute (true parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }) => {
      if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;
      if (!prefs?.reactive_execution?.enabled) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const subagentModel = prefs?.reactive_execution?.subagent_model
        ?? prefsModels?.resolveModelWithFallbacksForUnit?.("subagent")?.primary;

      const allTaskIds = getTaskIds(basePath, mid, sid);
      const wavePlan = loadWaves(basePath, mid, sid, allTaskIds);
      if (!wavePlan.ok) {
        if (reactiveGraph?.clearReactiveState) reactiveGraph.clearReactiveState(basePath, mid, sid);
        return null;
      }

      const dbAvailable = typeof dbModule?.isDbAvailable === "function" && dbModule.isDbAvailable();
      const statusMap = { completed: [], running: [], unstarted: [] };

      for (const tid of allTaskIds) {
        let status = "pending";
        if (dbAvailable && typeof dbModule?.getTask === "function") {
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
        return null; // all done
      }

      // Strict wave barrier: find minimum wave among incomplete tasks
      const incompleteTasks = [...statusMap.running, ...statusMap.unstarted];
      incompleteTasks.sort((a, b) => a.wave - b.wave);
      const activeWave = incompleteTasks[0].wave;

      // Only dispatch tasks belonging to the current active wave
      const eligibleToStart = statusMap.unstarted.filter(t => t.wave === activeWave).map(t => t.id);
      if (eligibleToStart.length === 0) return null; // waiting for current wave

      // Concurrency throttle
      const runningInActiveWave = statusMap.running.filter(t => t.wave === activeWave).length;
      if (runningInActiveWave >= waveSize) return null;

      // Deterministic ordering
      const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
      eligibleToStart.sort(TASK_COLLATOR.compare);
      const selectedTask = eligibleToStart[0];

      // Render the wave dashboard
      const waveNumbers = [...new Set(allTaskIds.map(id => wavePlan.waves[id]))];
      const totalWaves = waveNumbers.length;
      const dashboardMd = renderWaveDashboard(activeWave, totalWaves, waveSize, statusMap);

      capturedCtx?.ui?.notify(dashboardMd, "info");

      if (reactiveGraph?.saveReactiveState) {
        reactiveGraph.saveReactiveState(basePath, mid, sid, {
          sliceId: sid,
          completed: statusMap.completed.map(t => t.id),
          dispatched: [selectedTask],
          currentWave: activeWave,
          graphSnapshot: { taskCount: allTaskIds.length, edgeCount: 0, readySetSize: eligibleToStart.length, ambiguous: false },
          updatedAt: new Date().toISOString()
        });
      }

      const unitId = `${mid}/${sid}/reactive+${selectedTask}`;

      const basePrompt = await promptsModule.buildReactiveExecutePrompt(
        mid, midTitle, sid, sTitle, [selectedTask], basePath, subagentModel,
        { sessionContextWindow, modelRegistry }
      );

      // Sandbox isolation block: STAY IN YOUR LANE
      const sandboxBlock = `

## 🌊 SANDBOXED WAVE EXECUTION 🌊

You are a parallel subagent. You are assigned EXACTLY ONE TASK: **${selectedTask}** (Wave ${activeWave}/${totalWaves}).
Other AI agents are currently modifying other files for this wave in parallel.

### 🛑 ISOLATION RULES (CRITICAL):
1. **STAY IN YOUR LANE:** ONLY implement the code required for **${selectedTask}**.
2. **BLIND CONCURRENCY:** Do not attempt to implement upcoming tasks. If you write code that belongs to another agent's task, you will cause Git Merge Conflicts and crash the build.
3. **USE COMPLETED WORK:** Assume previous waves are perfectly completed. Use their classes/functions.`;

      return {
        action: "dispatch",
        unitType: "reactive-execute",
        unitId,
        prompt: basePrompt + sandboxBlock
      };
    }
  };
}

export function patchDispatchRules(core, pi, capturedCtx) {
  const DISPATCH_RULES = core["auto-dispatch"].DISPATCH_RULES;
  if (!Array.isArray(DISPATCH_RULES)) {
    capturedCtx?.ui?.notify?.("DISPATCH_RULES is not an array — cannot patch", "error");
    return;
  }

  const waveSize = loadWaveSize(capturedCtx);
  const planSlicePatcher = buildPlanSlicePatcher(waveSize, capturedCtx);
  const reactiveGraph = core["reactive-graph"];
  const dbModule = core["gsd-db"];
  const promptsModule = core["auto-prompts"];
  const prefsModels = core["preferences-models"];

  // Patch plan-slice rule
  const planRuleIdx = DISPATCH_RULES.findIndex(r => r.name === "planning → plan-slice");
  if (planRuleIdx !== -1) {
    const originalRule = DISPATCH_RULES[planRuleIdx];
    const originalMatch = originalRule.match;
    DISPATCH_RULES[planRuleIdx] = {
      ...originalRule,
      match: async (args) => {
        const result = await originalMatch(args);
        if (!result) return null;
        return planSlicePatcher(result);
      }
    };
  }

  // Replace reactive-execute rule with Enforcer + Reactive rules
  const reactiveRuleIdx = DISPATCH_RULES.findIndex(r =>
    r.name.includes("reactive-execute (parallel dispatch)")
  );
  if (reactiveRuleIdx !== -1) {
    DISPATCH_RULES.splice(reactiveRuleIdx, 1,
      buildEnforceWaveRule(waveSize, capturedCtx, reactiveGraph),
      buildWaveReactiveRule(waveSize, capturedCtx, dbModule, promptsModule, reactiveGraph, prefsModels)
    );
  }
}
