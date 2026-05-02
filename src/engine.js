import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadAndValidateDeps, computeReadySet, calculateDagMetrics, persistLatestError, clearLatestError, loadDepsError } from "./deps.js";
import { dagExecutionLoop } from "./dag-engine.js";
import { payloadStore } from "./payload-store.js";

const width1Warned = new Map();

const disableOfficialRules = (rules) => {
  const re = rules.find(r => r.name?.includes("reactive-execute"));
  if (re) {
    re.match = async () => null;
    re.name = "[DAG Disabled] reactive-execute";
  }
  const et = rules.find(r => r.name?.includes("execute-task"));
  if (et) {
    et.match = async () => null;
    et.name = "[DAG Disabled] execute-task";
  }
};

const registerDagRule = (rules, core, autoDispatch, dagWidget, dagTaskManagers) => {
  const dagRule = {
    name: "executing → dag-execution",
    match: async (ctx) => executeDagRule(ctx, core, autoDispatch, dagWidget, dagTaskManagers),
  };
  const execIdx = rules.findIndex(r => r.name?.includes("executing →") || r.name?.includes("executing"));
  if (execIdx >= 0) rules.splice(execIdx, 0, dagRule);
  else rules.push(dagRule);
};

const loadPiCodingAgent = async (ctx) => {
  const piCodingAgent = await import("@gsd/pi-coding-agent");
  const agentDir = piCodingAgent.getAgentDir();
  const cwd = ctx.cwd ?? process.cwd();
  return {
    createAgentSessionFn: piCodingAgent.createAgentSession,
    sessionManager: piCodingAgent.SessionManager.inMemory(cwd),
    settingsManager: piCodingAgent.SettingsManager.create(cwd, agentDir),
    agentDir,
  };
};

const executeDagTool = async (_params, signal, ctx, dagTaskManagers) => {
  const payload = payloadStore.get(_params.unitId);
  if (!payload) return { content: [{ type: "text", text: "No DAG payload found for this unitId." }], details: { unitId: _params.unitId, error: "payload_not_found" } };
  payloadStore.delete(_params.unitId);

  const { deps, allTasks, contextToolkit, db, dagWidget } = payload;

  let agentConfig;
  try {
    agentConfig = await loadPiCodingAgent(ctx);
  } catch (err) {
    ctx?.ui?.notify?.(`[DAG] Failed to load pi-coding-agent: ${err.message}`, "error");
    return { content: [{ type: "text", text: `DAG initialization failed: ${err.message}` }], details: { error: "pi_coding_agent_load_failed", message: err.message } };
  }

  try {
    const result = await dagExecutionLoop(deps, allTasks, contextToolkit, db, dagWidget, agentConfig.createAgentSessionFn, signal, agentConfig.sessionManager, agentConfig.settingsManager, agentConfig.agentDir, ctx, dagTaskManagers);
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
    execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => executeDagTool(_params, signal, ctx, dagTaskManagers),
  });
};

export function injectExplicitDagEngine(core, pi, sessionCtx, dagWidget, dagTaskManagers) {
  const autoDispatch = core["auto-dispatch"];
  if (!autoDispatch?.DISPATCH_RULES) return;
  const rules = autoDispatch.DISPATCH_RULES;
  if (rules._dagInjected) return;
  rules._dagInjected = true;
  disableOfficialRules(rules);
  registerDagRule(rules, core, autoDispatch, dagWidget, dagTaskManagers);
  registerWaitTool(pi, dagTaskManagers);
}

async function executeDagRule(ctx, core, autoDispatch, dagWidget, dagTaskManagers) {
  if (ctx.state.phase !== "executing" || !ctx.state.activeTask || !ctx.state.activeSlice) return null;

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

  const ready = computeReadySet(deps, tasks);
  if (ready.length === 0) {
    const doneStatuses = new Set(["complete", "done", "skipped", "success"]);
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

  const unitId = `${mid}/${sid}/${ctx.state.activeTask.id}`;
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
    const planResult = await planRule.match(ctx);
    if (planResult?.prompt) {
      planResult.prompt = `**PLAN REJECTED: DEPS.json ERROR** 🚨\nYou MUST rewrite the DEPS.json file correctly.\n${errorBlock}\n\n---\n\n${planResult.prompt}`;
    }
    return planResult;
  } finally {
    ctx.state.phase = originalPhase;
  }
}

