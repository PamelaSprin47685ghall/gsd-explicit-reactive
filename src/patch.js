import { getTaskIds, loadWaves } from "./waves.js";
import { loadWaveSize } from "./settings.js";

function buildPlanSlicePatcher(waveSize) {
  return function patchPlanSlice(args) {
    const { mid, state } = args;
    const sid = state.activeSlice.id;
    args.prompt += `\n\n## Task Waves\n\nCreate \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\`:\n\`\`\`json\n{\n  "T01": 1,\n  "T02": 1,\n  "T03": 2\n}\n\`\`\`\nWave number is a positive integer. Same-wave tasks run concurrently (max ${waveSize}).`;
    return args;
  };
}

function buildEnforceWaveRule(capturedCtx, reactiveGraph) {
  return {
    name: "executing → enforce-explicit-waves",
    match: async ({ state, mid, basePath }) => {
      if (state.phase !== "executing" || !state.activeSlice) return null;
      const sid = state.activeSlice.id;
      const allTaskIds = getTaskIds(basePath, mid, sid);
      const wavePlan = loadWaves(basePath, mid, sid, allTaskIds);
      if (wavePlan.ok) return null;

      capturedCtx?.ui?.notify(`WAVES.json: ${wavePlan.reason}`, "warning");

      if (reactiveGraph?.clearReactiveState)
        reactiveGraph.clearReactiveState(basePath, mid, sid);

      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId: `${mid}/${sid}`,
        prompt: `# Fix WAVES.json\n\nReason: ${wavePlan.reason}\n\nFix \`.gsd/milestones/${mid}/slices/${sid}/WAVES.json\`. Example:\n\`\`\`json\n{\n  "T01": 1,\n  "T02": 1,\n  "T03": 2\n}\n\`\`\``
      };
    }
  };
}

function buildWaveReactiveRule(waveSize, capturedCtx, dbModule, promptsModule, reactiveGraph, prefsModels) {
  return {
    name: "executing → explicit-reactive-execute (parallel dispatch)",
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
        if (reactiveGraph?.clearReactiveState)
          reactiveGraph.clearReactiveState(basePath, mid, sid);
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
        done ? completed.add(tid) : pending.push({ id: tid, wave: wavePlan.waves[tid] });
      }

      if (pending.length === 0) {
        if (reactiveGraph?.clearReactiveState)
          reactiveGraph.clearReactiveState(basePath, mid, sid);
        return null;
      }

      const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
      pending.sort((a, b) => a.wave - b.wave || TASK_COLLATOR.compare(a.id, b.id));
      const minWave = pending[0].wave;
      const currentWaveIds = pending.filter(t => t.wave === minWave).map(t => t.id);

      if (currentWaveIds.length <= 1) {
        if (reactiveGraph?.clearReactiveState)
          reactiveGraph.clearReactiveState(basePath, mid, sid);
        return null;
      }

      const selected = currentWaveIds.slice(0, waveSize);
      capturedCtx?.ui?.notify(`Wave ${minWave}: ${selected.length} tasks (max ${waveSize})`, "info");

      const unitId = `${mid}/${sid}/reactive+${selected.join(",")}`;

      if (reactiveGraph?.saveReactiveState)
        reactiveGraph.saveReactiveState(basePath, mid, sid, {
          sliceId: sid,
          completed: Array.from(completed),
          dispatched: selected,
          graphSnapshot: { taskCount: allTaskIds.length, edgeCount: 0, readySetSize: currentWaveIds.length, ambiguous: false },
          updatedAt: new Date().toISOString()
        });

      return {
        action: "dispatch",
        unitType: "reactive-execute",
        unitId,
        prompt: await promptsModule.buildReactiveExecutePrompt(
          mid, midTitle, sid, sTitle, selected, basePath, subagentModel,
          { sessionContextWindow, modelRegistry }
        )
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

  const reactiveRuleIdx = DISPATCH_RULES.findIndex(r =>
    r.name.includes("reactive-execute (parallel dispatch)")
  );
  if (reactiveRuleIdx !== -1) {
    DISPATCH_RULES.splice(reactiveRuleIdx, 1,
      buildEnforceWaveRule(capturedCtx, reactiveGraph),
      buildWaveReactiveRule(waveSize, capturedCtx, dbModule, promptsModule, reactiveGraph, prefsModels)
    );
  }
}
