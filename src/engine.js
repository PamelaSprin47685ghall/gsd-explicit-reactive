import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadAndValidateDeps, computeReadySet, calculateDagMetrics, persistLatestError, clearLatestError, loadDepsError } from "./deps.js";
import { dagExecutionLoop } from "./dag-engine.js";
import { payloadStore } from "./payload-store.js";

const width1Warned = new Map();

const DEPS_PROMPT_HINT = "\n\n**MANDATORY**: You MUST also output a `DEPS.json` file in the same directory as `PLAN.md` to define task dependencies for parallel execution. Format:\n```json\n{\n  \"version\": 1,\n  \"tasks\": {\n    \"T01\": { \"depends_on\": [] },\n    \"T02\": { \"depends_on\": [\"T01\"] }\n  }\n}\n```";

const disableOfficialRules = (rules) => {
  rules.filter(r => r.name?.includes("reactive-execute")).forEach(r => {
    r.match = async () => null;
    r.name = `[DAG Disabled] ${r.name}`;
  });
  rules.filter(r => r.name?.includes("execute-task")).forEach(r => {
    r.match = async () => null;
    r.name = `[DAG Disabled] ${r.name}`;
  });
};

const disableRegistryRules = (rules) => {
  rules.filter(r => r.name?.includes("reactive-execute")).forEach(r => {
    r.where = async () => null;
    r.name = `[DAG Disabled] ${r.name}`;
  });
  rules.filter(r => r.name?.includes("execute-task")).forEach(r => {
    r.where = async () => null;
    r.name = `[DAG Disabled] ${r.name}`;
  });
};

const patchRegistryPlanRule = (rules) => {
  const planRule = rules.find(r => r.name?.includes("plan-slice"));
  if (planRule && !planRule._dagPatched) {
    planRule._dagPatched = true;
    const originalWhere = planRule.where;
    planRule.where = async (ctx) => {
      const result = await originalWhere(ctx);
      if (result && result.prompt) {
        result.prompt += DEPS_PROMPT_HINT;
      }
      return result;
    };
  }
};

const registerDagRule = (rules, dagRule) => {
  if (rules._dagInjected) return;
  
  // Patch plan-slice to demand DEPS.json
  const planRule = rules.find(r => r.name?.includes("plan-slice"));
  if (planRule) {
    const originalMatch = planRule.match;
    planRule.match = async (ctx) => {
      const result = await originalMatch(ctx);
      if (result && result.prompt) {
        result.prompt += DEPS_PROMPT_HINT;
      }
      return result;
    };
  }

  const reactiveIdx = rules.findIndex(r => r.name?.includes("reactive-execute"));
  if (reactiveIdx >= 0) {
    rules.splice(reactiveIdx, 0, dagRule);
  } else {
    const execIdx = rules.findIndex(r => r.name?.includes("executing →") || r.name?.includes("executing"));
    if (execIdx >= 0) rules.splice(execIdx, 0, dagRule);
    else rules.push(dagRule);
  }
};

const registerRegistryDagRule = (rules, dagRule, convertFn) => {
  if (rules.some(r => r.name === dagRule.name)) return;
  const unifiedDagRule = convertFn([dagRule])[0];
  const reactiveIdx = rules.findIndex(r => r.name?.includes("reactive-execute"));
  if (reactiveIdx >= 0) {
    rules.splice(reactiveIdx, 0, unifiedDagRule);
  } else {
    const execIdx = rules.findIndex(r => r.name?.includes("executing"));
    if (execIdx >= 0) rules.splice(execIdx, 0, unifiedDagRule);
    else rules.push(unifiedDagRule);
  }
};

const executeDagTool = async (_params, signal, _onUpdate, ctx, dagTaskManagers, pi) => {
  const payload = payloadStore.get(_params.unitId);
  if (!payload) return { content: [{ type: "text", text: "No DAG payload found for this unitId." }], details: { unitId: _params.unitId, error: "payload_not_found" } };
  payloadStore.delete(_params.unitId);

  const { deps, allTasks, contextToolkit, db, dagWidget, dagTaskManagers: payloadDagTaskManagers } = payload;
  const effectiveDagTaskManagers = payloadDagTaskManagers || dagTaskManagers;

  if (!pi?.createAgentSession) {
    ctx?.ui?.notify?.("[DAG] pi.createAgentSession not available", "error");
    return { content: [{ type: "text", text: "DAG initialization failed: pi.createAgentSession not available" }], details: { error: "no_create_agent_session" } };
  }

  try {
    const result = await dagExecutionLoop(deps, allTasks, contextToolkit, db, dagWidget, pi.createAgentSession, signal, _onUpdate, ctx, effectiveDagTaskManagers);
    ctx?.ui?.notify?.(`[DAG] Successfully completed ${result.completed.length} tasks.`, "success");
    return { content: [{ type: "text", text: `All DAG tasks completed. Done: ${result.completed.length}/${result.total}.` }], details: { completed: result.completed, total: result.total } };
  } catch (err) {
    return { content: [{ type: "text", text: `DAG execution failed catastrophically: ${err.message}` }], details: { error: "dag_execution_failed", message: err.message } };
  }
};

const registerWaitTool = (pi, dagTaskManagers) => {
  pi.registerTool({
    name: "_wait_for_dag_completion",
    label: "Wait for DAG Completion",
    description: "Blocks until all DAG background tasks complete.",
    parameters: { type: "object", properties: { unitId: { type: "string", description: "DAG execution unit ID from the dispatch prompt" } }, required: ["unitId"] },
    execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => executeDagTool(_params, signal, _onUpdate, ctx, dagTaskManagers, pi),
  });
};

export function injectExplicitDagEngine(core, pi, sessionCtx, dagWidgets, dagTaskManagers) {
  const autoDispatch = core["auto-dispatch"];
  if (!autoDispatch?.DISPATCH_RULES) return;
  const rules = autoDispatch.DISPATCH_RULES;
  
  const dagRule = {
    name: "executing → dag-execution",
    match: async (ctx) => executeDagRule(ctx, core, autoDispatch, dagWidgets, dagTaskManagers),
  };

  if (!rules._dagInjected) {
    rules._dagInjected = true;
    disableOfficialRules(rules);
    registerDagRule(rules, dagRule);
    registerWaitTool(pi, dagTaskManagers);
  }

  // Patch the Registry if it exists and is initialized
  try {
    const registryMod = core["rule-registry"];
    if (registryMod && typeof registryMod.getRegistry === "function") {
      const registry = registryMod.getRegistry();
      if (registry && Array.isArray(registry.dispatchRules)) {
        disableRegistryRules(registry.dispatchRules);
        patchRegistryPlanRule(registry.dispatchRules);
        
        // Use a modified version of dagRule for the registry (if convertDispatchRules is available)
        const registryDagRule = {
          name: "executing → dag-execution",
          match: async (ctx) => executeDagRule(ctx, core, autoDispatch, dagWidgets, dagTaskManagers),
        };
        registerRegistryDagRule(registry.dispatchRules, registryDagRule, registryMod.convertDispatchRules);
      }
    }
  } catch (err) {
    // Registry not initialized yet, will be initialized later with modified DISPATCH_RULES
  }
}

async function executeDagRule(ctx, core, autoDispatch, dagWidgets, dagTaskManagers) {
  if (ctx.state.phase !== "executing" || !ctx.state.activeSlice) return null;

  const sessionId = ctx.sessionManager?.getSessionId?.();
  const dagWidget = sessionId ? dagWidgets?.get(sessionId) : null;

  const mid = ctx.mid;
  const sid = ctx.state.activeSlice.id;
  const basePath = ctx.basePath;
  const db = core["gsd-db"];
  if (!db?.isDbAvailable()) return null;

  const tasks = db.getSliceTasks(mid, sid);
  if (!tasks || tasks.length === 0) return null;

  const { deps, error, errors } = loadAndValidateDeps(basePath, mid, sid, tasks);
  if (error || !deps) {
    persistLatestError(basePath, mid, sid, errors ?? error ?? "...", deps ?? {}, ctx);
    width1Warned.delete(`${mid}/${sid}`);
    return backToPlanWithError(ctx, autoDispatch);
  }

  const doneStatuses = new Set(["complete", "done", "skipped", "success"]);
  const completedIds = new Set(tasks.filter(t => doneStatuses.has(t.status?.toLowerCase())).map(t => t.id));
  const ready = computeReadySet(deps, tasks, completedIds);

  if (ready.length === 0) {
    const allDone = tasks.every(t => doneStatuses.has(t.status?.toLowerCase()));
    if (allDone) return null;
    const incomplete = tasks.filter(t => !doneStatuses.has(t.status?.toLowerCase())).map(t => t.id);
    persistLatestError(basePath, mid, sid, `Deadlock detected: no ready tasks but ${incomplete.length} incomplete: [${incomplete.join(", ")}]. Check for missing dependencies or circular references.`, deps, ctx);
    return backToPlanWithError(ctx, autoDispatch);
  }

  const key = `${mid}/${sid}`;
  const { totalTasks, averageWidth } = calculateDagMetrics(deps);
  if (totalTasks >= 3 && averageWidth < 1.5 && !width1Warned.has(key)) {
    width1Warned.set(key, true);
    persistLatestError(basePath, mid, sid, `DAG average concurrency width is ${averageWidth.toFixed(2)} (< 1.5). Please restructure dependencies to allow more parallel execution.`, deps, ctx);
    return backToPlanWithError(ctx, autoDispatch);
  }

  clearLatestError(basePath, mid, sid, ctx);
  width1Warned.delete(key);

  ctx?.ui?.notify?.(`[DAG] Starting parallel execution for ${ready.length} tasks: ${ready.join(", ")}`, "info");

  // Mark all ready tasks as in_progress so GSD state machine knows they're being executed
  for (const taskId of ready) {
    try {
      db.updateTaskStatus?.(mid, sid, taskId, "in_progress");
    } catch (err) {
      ctx?.ui?.notify?.(`[DAG] Failed to mark ${taskId} as in_progress: ${err.message}`, "warning");
    }
  }

  const readMilestoneContext = (basePath, mid) => {
    const path = join(basePath, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`);
    try { if (existsSync(path)) return readFileSync(path, "utf-8").slice(0, 2000); } catch {}
    return null;
  };

  const readTaskPlans = (basePath, mid, sid, tasks) => {
    const plans = {};
    for (const t of tasks) {
      const path = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks", `${t.id}-PLAN.md`);
      try { if (existsSync(path)) plans[t.id] = readFileSync(path, "utf-8"); } catch {}
    }
    return plans;
  };

  const contextToolkit = {
    mid, sid, basePath,
    milestoneContext: readMilestoneContext(basePath, mid),
    sliceGoal: ctx.state.activeSlice.goal ?? ctx.state.activeSlice.title ?? sid,
    taskPlans: readTaskPlans(basePath, mid, sid, tasks),
    db,
  };

  const batchSuffix = ready.join(",");
  const unitId = `${mid}/${sid}/dag+${batchSuffix}`;
  payloadStore.set(unitId, { deps, allTasks: tasks, contextToolkit, db, dagWidget, dagTaskManagers }, 600000);

  return {
    action: "dispatch",
    unitType: "dag-execution",
    unitId,
    prompt: `You are the DAG Execution Coordinator.\nYou MUST immediately call \`_wait_for_dag_completion\` with { "unitId": "${unitId}" }.\nDo not output any other text.\nThe tool will block until all parallel background tasks finish.`,
  };
}

async function backToPlanWithError(ctx, autoDispatch) {
  const rules = autoDispatch?.DISPATCH_RULES ?? [];
  const planRule = rules.find(r => r.name?.includes("plan-slice"));

  const sid = ctx.state.activeSlice?.id;
  const mid = ctx.mid;
  const basePath = ctx.basePath;

  const errorData = sid ? loadDepsError(basePath, mid, sid) : null;
  const errorLines = errorData?.errors?.length ? errorData.errors.map(e => `- ${e}`) : [];
  const errorBlock = errorLines.length > 0 ? `\n## DEPS Validation Errors\n${errorLines.join("\n")}` : "";

  if (!planRule) {
    return {
      action: "stop",
      reason: `DEPS.json error in ${mid}/${sid}. No plan-slice dispatch rule found — cannot redispatch.` + (errorBlock ? `\nErrors:\n${errorLines.join("\n")}` : ""),
      level: "error",
    };
  }

  const originalPhase = ctx.state.phase;
  ctx.state.phase = "planning";
  try {
    const matchFn = planRule.match || planRule.where;
    if (typeof matchFn !== "function") {
      return {
        action: "stop",
        reason: `plan-slice rule found but no match/where function available.`,
        level: "error",
      };
    }
    const planResult = await matchFn(ctx);
    if (planResult?.prompt) {
      planResult.prompt = `**PLAN REJECTED: DEPS.json ERROR** 🚨\nYou MUST rewrite the DEPS.json file correctly.\n${errorBlock}\n\n---\n\n${planResult.prompt}`;
    }
    return planResult;
  } finally {
    ctx.state.phase = originalPhase;
  }
}
