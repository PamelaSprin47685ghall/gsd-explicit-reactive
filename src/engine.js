import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadAndValidateDeps, computeReadySet, persistLatestError, clearLatestError, loadDepsError } from "./deps.js";
import { dagExecutionLoop } from "./dag-engine.js";

/** Per-slice width-1 warning tracker: Map<"mid/sid", warned> */
const width1Warned = new Map();

/** Map<sessionId, payload> storing per-session DAG payload for _wait_for_dag_completion tool */
const dagPayloadBySessionId = new Map();

export function injectExplicitDagEngine(core, pi) {
  const autoDispatch = core["auto-dispatch"];
  if (!autoDispatch?.DISPATCH_RULES) return;

  const rules = autoDispatch.DISPATCH_RULES;
  if (rules._dagInjected) return;
  rules._dagInjected = true;

  // 1. Disable official reactive-execute rule
  const re = rules.find(r => r.name?.includes("reactive-execute"));
  if (re) {
    re.match = async () => null;
    re.name = "[DAG Disabled] reactive-execute";
  }

  // 2. Disable official execute-task rule
  const et = rules.find(r => r.name?.includes("execute-task"));
  if (et) {
    et.match = async () => null;
    et.name = "[DAG Disabled] execute-task";
  }

  // 3. Globally disable subagent in all dispatch prompts
  for (const rule of rules) {
    const origMatch = rule.match;
    rule.match = async (ctx) => {
      const result = await origMatch(ctx);
      if (result?.prompt) {
        result.prompt =
          "**The subagent tool is globally disabled.**\n" + result.prompt;
      }
      return result;
    };
  }

  // 4. Register DAG dispatch rule (before "executing →" rules so it wins)
  const dagRule = {
    name: "executing → dag-execution",
    match: async (ctx) => executeDagRule(ctx, core, pi, autoDispatch),
  };

  const execIdx = rules.findIndex(r => r.name?.includes("executing →") || r.name?.includes("executing"));
  if (execIdx >= 0) {
    rules.splice(execIdx, 0, dagRule);
  } else {
    rules.push(dagRule);
  }

  // 5. Register the _wait_for_dag_completion tool globally via pi.registerTool
  //    Session-specific DAG payload is stored in a WeakMap keyed on the session.
  pi.registerTool({
    name: "_wait_for_dag_completion",
    description: "Blocks until all DAG background tasks complete.",
    parameters: { type: "object", properties: {} },
    execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      const payload = sessionId ? dagPayloadBySessionId.get(sessionId) : undefined;
      if (!payload) return "No DAG payload found for this session.";

      const { deps, allTasks, contextToolkit, db, createAgentSessionFn, sessionManager, settingsManager, agentDir } = payload;

      const result = await dagExecutionLoop(
        deps, allTasks, contextToolkit, pi, db, pi._dagWidget,
        createAgentSessionFn, signal,
        sessionManager, settingsManager, agentDir
      );
      if (sessionId) dagPayloadBySessionId.delete(sessionId);
      return `All DAG tasks completed. Done: ${result.completed.length}/${result.total}.`;
    },
  });

  // 6. On session_start for dag-execution, store the DAG payload and
  //    import the agent session factory with isolated session/settings managers.
  pi.on("session_start", async (_event, captureCtx) => {
    if (captureCtx.unitType !== "dag-execution") return;
    const payload = captureCtx._dagPayload;
    if (!payload) return;

    // Import createAgentSession, SessionManager, SettingsManager, getAgentDir
    try {
      const piCodingAgent = await import("@gsd/pi-coding-agent");
      const createAgentSessionFn = piCodingAgent.createAgentSession;
      const SessionManager = piCodingAgent.SessionManager;
      const SettingsManager = piCodingAgent.SettingsManager;
      const getAgentDir = piCodingAgent.getAgentDir;

      const agentDir = getAgentDir();
      const sessionManager = SessionManager.inMemory(captureCtx.cwd ?? process.cwd());
      const settingsManager = SettingsManager.create(captureCtx.cwd ?? process.cwd(), agentDir);

      const sessionId = captureCtx.sessionManager?.getSessionId?.() ?? captureCtx.session?.id;
      if (sessionId) {
        dagPayloadBySessionId.set(sessionId, {
          ...payload,
          createAgentSessionFn,
          sessionManager,
          settingsManager,
          agentDir,
        });
      }
    } catch (err) {
      console.error(`[DAG] Failed to load pi-coding-agent for dag-execution: ${err.message}`);
    }
  });
}

/**
 * Main DAG dispatch rule logic.
 * Returns a dispatch action or a back-to-plan action depending on DEPS state.
 */
async function executeDagRule(ctx, core, pi, autoDispatch) {
  if (ctx.state.phase !== "executing" || !ctx.state.activeTask || !ctx.state.activeSlice) {
    return null;
  }

  const mid = ctx.mid;
  const sid = ctx.state.activeSlice.id;
  const basePath = ctx.basePath;
  const db = core["gsd-db"];
  if (!db?.isDbAvailable()) return null;

  const tasks = db.getSliceTasks(mid, sid);
  if (!tasks || tasks.length === 0) return null;

  // Load and validate DEPS.json
  const { deps, error, errors } = loadAndValidateDeps(basePath, mid, sid, tasks);

  if (error || !deps) {
    persistLatestError(basePath, mid, sid, errors ?? error ?? "...", deps ?? {});
    width1Warned.delete(`${mid}/${sid}`);
    return backToPlanWithError(ctx, autoDispatch);
  }

  // DEPS valid → compute ready set
  const ready = computeReadySet(deps, tasks);

  if (ready.length === 0) {
    return null;
  }

  // Width-1 handling: first time → reject to encourage wider parallelism
  const key = `${mid}/${sid}`;
  if (ready.length === 1 && !width1Warned.has(key)) {
    width1Warned.set(key, true);
    persistLatestError(
      basePath, mid, sid,
      "DAG natural width is 1. Please restructure dependencies to allow parallel execution where possible.",
      deps
    );
    return backToPlanWithError(ctx, autoDispatch);
  }

  // Valid DEPS, width >= 1 (or retry after width-1 warning) → proceed
  const previousDepsError = loadDepsError(basePath, mid, sid);
  clearLatestError(basePath, mid, sid);

  // Build context toolkit for the DAG engine

  const contextToolkit = {
    mid,
    sid,
    milestoneContext: await readMilestoneContext(basePath, mid),
    sliceGoal: ctx.state.activeSlice.goal ?? ctx.state.activeSlice.title ?? sid,
    taskPlans: await readTaskPlans(basePath, mid, sid, tasks),
    completedDeps: buildCompletedDepSummaries(tasks, deps),
    depsError: previousDepsError,
    db,
  };

  // Store payload on ctx for _wait_for_dag_completion to pick up
  ctx._dagPayload = { deps, allTasks: tasks, contextToolkit, db };

  return {
    action: "dispatch",
    unitType: "dag-execution",
    unitId: `${mid}/${sid}/${ctx.state.activeTask.id}`,
    prompt:
      "You are the DAG Execution Coordinator.\n" +
      "You MUST immediately call `_wait_for_dag_completion` tool.\n" +
      "Do not output any other text.\n" +
      "The tool will block until all parallel background tasks finish.",
  };
}

/**
 * Return a plan-slice dispatch action with DEPS-ERROR.json content injected.
 * Reads DEPS-ERROR.json directly so the caller doesn't need to pass error context.
 */
async function backToPlanWithError(ctx, autoDispatch) {
  const rules = autoDispatch?.DISPATCH_RULES ?? [];
  const planRule = rules.find(r => r.name?.includes("plan-slice"));

  const sid = ctx.state.activeSlice?.id;
  const mid = ctx.mid;
  const basePath = ctx.basePath;

  // Load DEPS-ERROR.json content for the prompt
  const errorData = sid ? loadDepsError(basePath, mid, sid) : null;
  const errorLines = errorData?.errors?.length
    ? errorData.errors.map(e => `- ${e}`)
    : [];

  const errorBlock = errorLines.length > 0
    ? `\n## DEPS Validation Errors\n${errorLines.join("\n")}`
    : "";

  if (!planRule) {
    // No plan-slice rule to fall back to — produce a stop action so the session isn't silently stuck
    return {
      action: "stop",
      reason:
        `DEPS.json error in ${mid}/${sid}. No plan-slice dispatch rule found — cannot redispatch.` +
        (errorBlock ? `\nErrors:\n${errorLines.join("\n")}` : ""),
      level: "error",
    };
  }

  const originalPhase = ctx.state.phase;
  ctx.state.phase = "planning";
  try {
    const planResult = await planRule.match(ctx);
    if (planResult?.prompt) {
      planResult.prompt =
        "**PLAN REJECTED: DEPS.json ERROR** 🚨\n" +
        "You MUST rewrite the DEPS.json file correctly.\n" +
        errorBlock +
        "\n\n---\n\n" +
        planResult.prompt;
    }
    return planResult;
  } finally {
    ctx.state.phase = originalPhase;
  }
}

/**
 * Read milestone CONTEXT file for injection into task agents.
 */
async function readMilestoneContext(basePath, mid) {
  const path = join(basePath, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`);
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").slice(0, 2000);
  } catch { /* ignore */ }
  return null;
}

/**
 * Read all task plan files for the slice.
 */
async function readTaskPlans(basePath, mid, sid, tasks) {
  const plans = {};
  for (const t of tasks) {
    const path = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks", `${t.id}-PLAN.md`);
    try {
      if (existsSync(path)) plans[t.id] = readFileSync(path, "utf-8");
    } catch { /* ignore */ }
  }
  return plans;
}

/**
 * Build summary strings for completed upstream dependencies.
 */
function buildCompletedDepSummaries(tasks, deps) {
  const doneStatuses = new Set(["complete", "done", "skipped", "success"]);
  const done = tasks.filter(t => doneStatuses.has(t.status?.toLowerCase()));
  if (done.length === 0) return [];
  return done.map(t => `- ${t.id}: ${t.title ?? t.id} (${t.status})`);
}
