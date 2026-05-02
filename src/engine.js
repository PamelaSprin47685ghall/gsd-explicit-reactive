import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadAndValidateDeps, computeReadySet, calculateDagMetrics, persistLatestError, clearLatestError, loadDepsError } from "./deps.js";
import { dagExecutionLoop } from "./dag-engine.js";

/** Per-slice width-1 warning tracker: Map<"mid/sid", warned> */
const width1Warned = new Map();

/**
 * TTL Map for DAG payload bridge. Entries expire 30s after creation (default).
 * Prevents orphaned payload leaks when dispatch is cancelled before the tool executes.
 */
const payloadStore = {
  _map: new Map(),
  _ttl: 30000,
  set(key, value, ttl) {
    const expiresIn = ttl ?? this._ttl;
    const old = this._map.get(key);
    if (old?.timer) clearTimeout(old.timer);
    let timer;
    if (expiresIn > 0) {
      timer = setTimeout(() => this._map.delete(key), expiresIn);
      timer.unref?.();
    }
    this._map.set(key, { value, createdAt: Date.now(), ttl: expiresIn, timer });
  },
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  },
  delete(key) {
    const old = this._map.get(key);
    if (old?.timer) clearTimeout(old.timer);
    this._map.delete(key);
  },
  has(key) {
    return this.get(key) !== undefined;
  },
};

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

  // 5. Register the _wait_for_dag_completion tool — payload lookup by unitId (passed by LLM)
  pi.registerTool({
    name: "_wait_for_dag_completion",
    description: "Blocks until all DAG background tasks complete.",
    parameters: {
      type: "object",
      properties: { unitId: { type: "string", description: "DAG execution unit ID from the dispatch prompt" } },
      required: ["unitId"],
    },
    execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
      const payload = payloadStore.get(_params.unitId);
      if (!payload) return "No DAG payload found for this unitId.";
      payloadStore.delete(_params.unitId);

      const { deps, allTasks, contextToolkit, db } = payload;

      // Import pi-coding-agent and create isolated session/settings managers
      let createAgentSessionFn, sessionManager, settingsManager, agentDir;
      try {
        const piCodingAgent = await import("@gsd/pi-coding-agent");
        createAgentSessionFn = piCodingAgent.createAgentSession;
        const SessionManager = piCodingAgent.SessionManager;
        const SettingsManager = piCodingAgent.SettingsManager;
        const getAgentDir = piCodingAgent.getAgentDir;
        agentDir = getAgentDir();
        sessionManager = SessionManager.inMemory(ctx.cwd ?? process.cwd());
        settingsManager = SettingsManager.create(ctx.cwd ?? process.cwd(), agentDir);
      } catch (err) {
        ctx?.ui?.notify?.(`[DAG] Failed to load pi-coding-agent: ${err.message}`, "error");
        return `DAG initialization failed: ${err.message}`;
      }

      try {
        try {
          const result = await dagExecutionLoop(
            deps, allTasks, contextToolkit, pi, db, pi._dagWidget,
            createAgentSessionFn, signal,
            sessionManager, settingsManager, agentDir, ctx
          );
          return `All DAG tasks completed. Done: ${result.completed.length}/${result.total}.`;
        } catch (err) {
          throw new Error(`DAG execution failed catastrophically: ${err.message}`);
        }
      } finally {
        // no sessionId payload to clean up — unitId entry already deleted above
      }
    },
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
    persistLatestError(basePath, mid, sid, errors ?? error ?? "...", deps ?? {}, ctx);
    width1Warned.delete(`${mid}/${sid}`);
    return backToPlanWithError(ctx, autoDispatch);
  }

  // DEPS valid → compute ready set
  const ready = computeReadySet(deps, tasks);

  if (ready.length === 0) {
    return null;
  }

  // Width check: use average concurrency width (N / critical path length)
  // Only warn for DAGs with ≥3 tasks where average width is too narrow
  const key = `${mid}/${sid}`;
  const { totalTasks, averageWidth } = calculateDagMetrics(deps);
  if (totalTasks >= 3 && averageWidth < 1.5 && !width1Warned.has(key)) {
    width1Warned.set(key, true);
    persistLatestError(
      basePath, mid, sid,
      `DAG average concurrency width is ${averageWidth.toFixed(2)} (< 1.5). ` +
      "Please restructure dependencies to allow more parallel execution.",
      deps,
      ctx
    );
    return backToPlanWithError(ctx, autoDispatch);
  }

  // Valid DEPS, width >= 1 (or retry after width-1 warning) → proceed
  clearLatestError(basePath, mid, sid, ctx);

  // Build context toolkit for the DAG engine

  const contextToolkit = {
    mid,
    sid,
    basePath,
    milestoneContext: await readMilestoneContext(basePath, mid),
    sliceGoal: ctx.state.activeSlice.goal ?? ctx.state.activeSlice.title ?? sid,
    taskPlans: await readTaskPlans(basePath, mid, sid, tasks),
    completedDeps: buildCompletedDepSummaries(tasks, deps),
    db,
  };

  // Store payload keyed by unitId — LLM passes it back via tool parameter
  const unitId = `${mid}/${sid}/${ctx.state.activeTask.id}`;
  payloadStore.set(unitId, { deps, allTasks: tasks, contextToolkit, db }, 600000);

  return {
    action: "dispatch",
    unitType: "dag-execution",
    unitId,
    prompt:
      "You are the DAG Execution Coordinator.\n" +
      "You MUST immediately call `_wait_for_dag_completion` " +
      `with { "unitId": "${unitId}" }.\n` +
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
