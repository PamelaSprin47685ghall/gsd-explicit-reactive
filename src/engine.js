import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadAndValidateDeps, computeReadySet, calculateDagMetrics, persistLatestError, clearLatestError, loadDepsError } from "./deps.js";
import { dagExecutionLoop } from "./dag-engine.js";
import { payloadStore } from "./payload-store.js";
import { createAgentSession } from "@gsd/pi-coding-agent";

export const width1Warned = new Map();
/** Prune stale width-1 warnings when a slice's DEPS is reloaded or cleared. */
const clearWidth1Warning = (mid, sid) => width1Warned.delete(`${mid}/${sid}`);

const DEPS_PROMPT_HINT = "\n\n**MANDATORY**: You MUST also output a `DEPS.json` file in the same directory as `PLAN.md` to define task dependencies for parallel execution. Format:\n```json\n{\n  \"version\": 1,\n  \"tasks\": {\n    \"T01\": { \"depends_on\": [] },\n    \"T02\": { \"depends_on\": [\"T01\"] }\n  }\n}\n```";

const waitToolRegistered = new WeakSet();
const sessionFactoryCache = new WeakMap();

const resolveCreateSessionFactory = () => {
  // Return the imported createAgentSession function
  return createAgentSession;
};

const getCurrentActiveToolNames = (ctx) => {
  try {
    // Try to get active tools from ctx.session
    if (ctx?.session?.getActiveToolNames) {
      const activeTools = ctx.session.getActiveToolNames();
      if (Array.isArray(activeTools)) return activeTools.filter(Boolean);
    }
    // Fallback: try ctx.tools
    if (Array.isArray(ctx?.tools)) {
      return ctx.tools.map(t => t.name).filter(Boolean);
    }
  } catch {}
  return [];
};

const isPrimaryExecuteTaskRule = (ruleName) => {
  if (typeof ruleName !== "string") return false;
  if (!ruleName.includes("executing → execute-task")) return false;
  if (ruleName.includes("recover missing task plan")) return false;
  return true;
};

const disableOfficialRules = (rules) => {
  rules.filter(r => r.name?.includes("reactive-execute") && !r._dagDisabled).forEach(r => {
    r._dagDisabled = true;
    r._dagOriginalName = r.name;
    r.match = async () => null;
  });
  rules.filter(r => isPrimaryExecuteTaskRule(r.name) && !r._dagDisabled).forEach(r => {
    r._dagDisabled = true;
    r._dagOriginalName = r.name;
    r.match = async () => null;
  });
};


const registerDagRule = (rules, dagRule) => {
  if (!rules.some(r => r.name === dagRule.name)) {
    const reactiveIdx = rules.findIndex(r => r.name?.includes("reactive-execute"));
    if (reactiveIdx >= 0) {
      rules.splice(reactiveIdx, 0, dagRule);
    } else {
      const execIdx = rules.findIndex(r => r.name?.includes("executing →") || r.name?.includes("executing"));
      if (execIdx >= 0) rules.splice(execIdx, 0, dagRule);
      else rules.push(dagRule);
    }
  }

  const planRule = rules.find(r => r.name?.includes("plan-slice"));
  if (planRule && !planRule._dagPatched) {
    planRule._dagPatched = true;
    const originalMatch = planRule.match;
    planRule.match = async (ctx) => {
      const result = await originalMatch(ctx);
      if (result && result.prompt && !result.prompt.includes("DEPS.json")) {
        result.prompt += DEPS_PROMPT_HINT;
      }
      return result;
    };
  }
};


const emitDagDispatchLog = (ctx, payload) => {
  try {
    const mid = ctx?.mid ?? "unknown-mid";
    const sid = ctx?.state?.activeSlice?.id ?? "unknown-slice";
    ctx?.ui?.notify?.(`[dag] ${mid}/${sid} ${JSON.stringify(payload)}`, "info");
  } catch {}
};

const executeDagTool = async (_params, signal, _onUpdate, ctx, dagTaskManagers) => {
  const payload = payloadStore.take(_params.unitId);
  if (!payload) return { content: [{ type: "text", text: "DAG payload expired or missing. Try re-dispatching the task." }], details: { unitId: _params.unitId, error: "payload_not_found" } };

  const { deps, allTasks, contextToolkit, db, dagWidget, dagTaskManagers: payloadDagTaskManagers } = payload;
  const effectiveDagTaskManagers = payloadDagTaskManagers || dagTaskManagers;

  const createSessionFactory = resolveCreateSessionFactory();
  if (!createSessionFactory) {
    return {
      content: [{ type: "text", text: "DAG initialization failed: createAgentSession unavailable" }],
      details: { error: "no_create_agent_session" },
    };
  }

  try {
    const result = await dagExecutionLoop(
      deps,
      allTasks,
      contextToolkit,
      db,
      dagWidget,
      createSessionFactory,
      signal,
      _onUpdate,
      { ...ctx, extraActiveToolNames: getCurrentActiveToolNames(ctx) },
      effectiveDagTaskManagers,
    );
    ctx?.ui?.notify?.(`DAG completed ${result.completed.length}/${result.total} tasks.`, "success");
    return { content: [{ type: "text", text: `All DAG tasks completed (${result.completed.length}/${result.total}).` }], details: { completed: result.completed, total: result.total } };
  } catch (err) {
    const msg = err.message?.length > 200 ? err.message.slice(0, 200) + "…" : err.message;
    return { content: [{ type: "text", text: `DAG execution failed: ${msg}` }], isError: true, details: { error: "dag_execution_failed", message: err.message } };
  }
};

export const registerWaitTool = (pi, dagTaskManagers) => {
  if (waitToolRegistered.has(pi)) return;
  waitToolRegistered.add(pi);

  pi.registerTool({
    name: "_wait_for_dag_completion",
    label: "Wait for DAG Completion",
    description: "Blocks until all DAG background tasks complete.",
    parameters: { type: "object", properties: { unitId: { type: "string", description: "DAG execution unit ID from the dispatch prompt" } }, required: ["unitId"] },
    execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => executeDagTool(_params, signal, _onUpdate, ctx, dagTaskManagers),
  });
};

export function injectExplicitDagEngine(core, pi, sessionCtx, dagWidgets, dagTaskManagers) {
  const autoDispatch = core["auto-dispatch"];
  const ruleRegistry = core["rule-registry"];
  if (!autoDispatch?.DISPATCH_RULES) {
    sessionCtx?.ui?.notify?.("[DAG] DISPATCH_RULES not found in auto-dispatch module", "error");
    return;
  }
  const rules = autoDispatch.DISPATCH_RULES;

  // Idempotency guard: check if DAG rule is already injected
  const existingDagRule = rules.find(r => r.name === "executing → dag (reactive-execute)");
  if (existingDagRule) {
    sessionCtx?.ui?.notify?.("[DAG] Rule already injected, skipping", "info");
    return;
  }

  const dagRule = {
    name: "executing → dag (reactive-execute)",
    match: async (ctx) => executeDagRule(ctx, core, autoDispatch, dagWidgets, dagTaskManagers),
  };

  disableOfficialRules(rules);
  registerDagRule(rules, dagRule);
  registerWaitTool(pi, dagTaskManagers);
  
  sessionCtx?.ui?.notify?.(`[DAG] Injected dispatch rule (total: ${rules.length} rules)`, "info");

  if (ruleRegistry?.initRegistry && ruleRegistry?.convertDispatchRules) {
    try {
      const unifiedRules = ruleRegistry.convertDispatchRules(rules);
      ruleRegistry.initRegistry(unifiedRules);
      sessionCtx?.ui?.notify?.("[DAG] Dispatch registry synchronized.", "info");
    } catch (err) {
      sessionCtx?.ui?.notify?.(`[DAG] Registry sync failed: ${err.message}`, "warning");
    }
  }
}

async function executeDagRule(ctx, core, autoDispatch, dagWidgets, dagTaskManagers) {
  if (ctx.state.phase !== "executing") return null;
  if (!ctx.state.activeSlice) {
    return {
      action: "stop",
      reason: "DAG dispatch blocked: current phase is \"executing\" but activeSlice is missing. Run /gsd doctor and re-derive state before retrying.",
      level: "error",
    };
  }

  const sessionId = ctx.sessionManager?.getSessionId?.();
  const dagWidget = sessionId ? dagWidgets?.get(sessionId) : null;

  const mid = ctx.mid;
  const sid = ctx.state.activeSlice.id;
  const basePath = ctx.basePath;
  const db = core["gsd-db"];
  if (!db?.isDbAvailable()) {
    return {
      action: "stop",
      reason: `DAG dispatch blocked for ${mid}/${sid}: gsd-db is unavailable in executing phase. Ensure DB is initialized, then resume auto-mode.`,
      level: "error",
    };
  }

  const tasks = db.getSliceTasks(mid, sid);
  if (!tasks || tasks.length === 0) {
    return {
      action: "stop",
      reason: `DAG dispatch blocked for ${mid}/${sid}: no tasks were returned by gsd-db while phase is \"executing\". This indicates state drift (slice plan/tasks missing or DB mismatch).`,
      level: "error",
    };
  }

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
    if (allDone) {
      return {
        action: "stop",
        reason: `DAG dispatch blocked for ${mid}/${sid}: all tasks already complete but phase is still \"executing\". State derivation may be stale — run /gsd doctor to reconcile.`,
        level: "warning",
      };
    }
    const incomplete = tasks.filter(t => !doneStatuses.has(t.status?.toLowerCase())).map(t => t.id);
    persistLatestError(basePath, mid, sid, `Deadlock detected: no ready tasks but ${incomplete.length} incomplete: [${incomplete.join(", ")}]. Check for missing dependencies or circular references.`, deps, ctx);
    return backToPlanWithError(ctx, autoDispatch);
  }

  const key = `${mid}/${sid}`;
  const { totalTasks, averageWidth, criticalPathLength } = calculateDagMetrics(deps);
  emitDagDispatchLog(ctx, {
    event: "ready-set",
    totalTasks,
    criticalPathLength,
    averageWidth: Number(averageWidth.toFixed(3)),
    completedCount: completedIds.size,
    readyCount: ready.length,
    ready,
  });
  if (totalTasks >= 3 && averageWidth < 1.5 && !width1Warned.has(key)) {
    width1Warned.set(key, true);
    persistLatestError(basePath, mid, sid, `DAG average concurrency width is ${averageWidth.toFixed(2)} (< 1.5). Please restructure dependencies to allow more parallel execution.`, deps, ctx);
    return backToPlanWithError(ctx, autoDispatch);
  }

  clearLatestError(basePath, mid, sid, ctx);
  width1Warned.delete(key);

  ctx?.ui?.notify?.(`[DAG] Starting parallel execution for ${ready.length} tasks: ${ready.join(", ")}`, "info");
  emitDagDispatchLog(ctx, { event: "dispatch", unitType: "reactive-execute", ready });

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
    try { return readFileSync(path, "utf-8").slice(0, 2000); } catch { return null; }
  };

  const readTaskPlans = (basePath, mid, sid, tasks) => {
    const plans = {};
    for (const t of tasks) {
      const path = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks", `${t.id}-PLAN.md`);
      try { plans[t.id] = readFileSync(path, "utf-8"); } catch {}
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

  // Use execute-task unitType so GSD's native verifyExpectedArtifact, auto-artifact-paths,
  // and state derivation recognize the unit without patching gsd-2.
  // The unitId format signals this is a DAG batch execution.
  const batchSuffix = ready.join(",");
  const unitId = `${mid}/${sid}/reactive+${batchSuffix}`;
  payloadStore.set(unitId, { deps, allTasks: tasks, contextToolkit, db, dagWidget, dagTaskManagers }, 600000);

  return {
    action: "dispatch",
    unitType: "execute-task",
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
    const unit = mid ? `${mid}/${sid ?? "?"}` : "(no milestone)";
    return {
      action: "stop",
      reason: `Cannot recover — no plan-slice rule available to redispatch in ${unit}.${errorLines.length > 0 ? `\nErrors:\n${errorLines.join("\n")}` : ""}`,
      level: "error",
    };
  }

  const matchFn = planRule.match || planRule.where;
  if (typeof matchFn !== "function") {
    return {
      action: "stop",
      reason: `plan-slice rule found but has no match function — cannot redispatch for ${mid}/${sid}.`,
      level: "error",
    };
  }

  // Deep-clone state to avoid polluting the real execution context.
  const planCtx = { ...ctx, state: { ...ctx.state, phase: "planning", activeSlice: ctx.state.activeSlice ? { ...ctx.state.activeSlice } : undefined } };
  const planResult = await matchFn(planCtx);

  if (!planResult) {
    return {
      action: "stop",
      reason: `Back-to-plan redispatch for ${mid}/${sid} failed: plan-slice rule returned empty result in executing phase. Ensure the slice is properly planned before execution.`,
      level: "error",
    };
  }

  if (planResult?.prompt) {
    planResult.prompt = `**DEPS.json validation failed.** You must fix the DEPS.json file.\n${errorBlock}\n\n---\n\n${planResult.prompt}`;
  }
  return planResult;
}
