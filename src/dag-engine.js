import { computeReadySet } from "./deps.js";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));

    let onAbort;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * DAG execution state: tracks all task agent sessions and their statuses.
 */
export class DagTaskManager {
  constructor() {
    /** @type {Map<string, { session, status, startedAt, unsubscribes }>} */
    this.agents = new Map();
    /** @type {Set<string>} Task IDs that have exhausted retries */
    this.failedTasks = new Set();
    /** @type {Map<string, AbortController>} Per-task abort controllers */
    this.abortControllers = new Map();
  }

  /**
   * Run a single task agent with infinite retry loop.
   * The agent gets a fresh session; subagent is filtered out from available tools.
   * Uses isolated SessionManager/SettingsManager to avoid concurrent state pollution.
   */
  async runTask(taskId, planContent, contextToolkit, pi, createAgentSessionFn,
                sessionManager, settingsManager, agentDir, abortSignal) {
    if (!createAgentSessionFn) {
      throw new Error("createAgentSession function not provided to runTask");
    }

    // Create a per-task AbortController cascaded from parent signal
    const taskAbort = new AbortController();
    this.abortControllers.set(taskId, taskAbort);

    // Placeholder entry so widget sees this task as running immediately
    this.agents.set(taskId, { session: null, status: "starting", startedAt: Date.now(), unsubscribes: [] });

    let session;
    try {
      const result = await createAgentSessionFn({
        cwd: pi.cwd,
        tools: pi.tools,
        sessionManager,
        settingsManager,
        modelRegistry: pi.modelRegistry,
        resourceLoader: pi.resourceLoader ?? new (await import("@gsd/pi-coding-agent")).DefaultResourceLoader(),
      });
      session = result.session;
    } catch (err) {
      this.abortControllers.delete(taskId);
      throw new Error(`Failed to create agent session for ${taskId}: ${err.message}`);
    }

    const toolNames = session.getActiveToolNames?.() ?? [];
    session.setActiveToolsByName?.(toolNames.filter(t => t !== "subagent" && t !== "_wait_for_dag_completion"));

    const placeholder = this.agents.get(taskId);
    const actualStartedAt = placeholder?.startedAt ?? Date.now();
    const record = { session, status: "running", startedAt: actualStartedAt, unsubscribes: [] };
    this.agents.set(taskId, record);

    // Subscribe to tool events and store the unsubscribe function (issue 11)
    if (session.subscribe) {
      const unsub = session.subscribe(event => {
        if (event.type === "tool_execution_start") {
          pi.notifyTaskActivity?.(taskId, event.toolName, event.args);
          record.tool = event.toolName;
        } else if (event.type === "tool_execution_end") {
          record.tool = null;
        }
      });
      record.unsubscribes.push(unsub);
    }

    // Forward task abort signal to session
    if (taskAbort.signal) {
      const unsubAbort = () => { if (taskAbort.signal.aborted) session.abort?.(); };
      if (taskAbort.signal.aborted) {
        unsubAbort();
      } else {
        taskAbort.signal.addEventListener("abort", unsubAbort, { once: true });
        record.unsubscribes.push(() =>
          taskAbort.signal.removeEventListener("abort", unsubAbort)
        );
      }
    }

    const basePrompt = buildTaskPrompt(taskId, planContent, contextToolkit);
    let currentPrompt = basePrompt;
    let retryCount = 0;
    let emptyTurnCount = 0;

    try {
      while (true) {
        // Hard abort check: parent signal triggered
        if (abortSignal?.aborted || taskAbort.signal.aborted) {
          record.status = "aborted";
          throw new Error("Task aborted");
        }

        try {
          await session.prompt(currentPrompt);

          if (isTaskCompleteInDb(taskId, contextToolkit)) {
            record.status = "completed";
            return;
          }

          currentPrompt =
            "You exited without calling `gsd_task_complete`. " +
            "You MUST finish the task and then call gsd_task_complete.";
          emptyTurnCount++;
          if (emptyTurnCount >= 10) {
            throw new Error(`Agent stuck: ${emptyTurnCount} consecutive empty turns without completing task.`);
          }
          await new Promise(r => setTimeout(r, 0));
        } catch (err) {
          // Abort check: rethrow immediately without backoff delay
          if (abortSignal?.aborted || taskAbort.signal.aborted) {
            record.status = "aborted";
            throw new Error("Task aborted");
          }
          currentPrompt = basePrompt +
            `\n\n**SYSTEM ERROR ON PREVIOUS ATTEMPT**:\n${err.message}\n` +
            "Please try another approach. Do not give up.";
          // Exponential backoff: 2s, 4s, 8s, 16s ... capped at 30s
          const delay = Math.min(2000 * Math.pow(2, retryCount), 30000);
          await sleep(delay, taskAbort.signal).catch(() => {});
          retryCount++;
        }
      }
    } finally {
      // Clean up all subscriptions (issue 11)
      for (const unsub of record.unsubscribes) {
        try { unsub(); } catch { /* ignore */ }
      }
      record.unsubscribes = [];
    }
  }

  /**
   * Abort all running task agents (issue 5, 9).
   */
  abortAll() {
    for (const [id, ctrl] of this.abortControllers) {
      try { ctrl.abort(); } catch { /* ignore */ }
    }
    // Also abort sessions directly for immediate effect
    for (const [id, rec] of this.agents) {
      if (rec.status === "running" && rec.session?.abort) {
        try { rec.session.abort(); } catch { /* ignore */ }
      }
    }
  }

  getStatus() {
    return Array.from(this.agents.entries()).map(([id, r]) => ({
      id,
      status: r.status,
      elapsed: Date.now() - r.startedAt,
    }));
  }
}

/**
 * Build the task agent prompt string from plan content and context toolkit.
 */
function buildTaskPrompt(taskId, planContent, contextToolkit) {
  const sections = [`# Execute task ${taskId}`];

  if (contextToolkit.milestoneContext) {
    sections.push(`## Milestone context\n${contextToolkit.milestoneContext}`);
  } else {
    sections.push("## Milestone context\nNo milestone context file available.");
  }

  sections.push(`## Slice goal\n${contextToolkit.sliceGoal}`);
  sections.push(`## Task plan\n${planContent}`);

  if (contextToolkit.dynamicCompletedDeps) {
    sections.push(contextToolkit.dynamicCompletedDeps);
  } else if (contextToolkit.completedDeps?.length > 0) {
    sections.push("## Completed dependencies\n" + contextToolkit.completedDeps.join("\n"));
  }

  sections.push(
    "## Execution rules (MANDATORY — follow exactly)\n" +
    "- This task runs in parallel with other tasks. Do NOT depend on other running tasks.\n" +
    "- You MUST call `gsd_task_complete` tool after finishing the task.\n" +
    "- You MUST NOT exit without calling `gsd_task_complete`.\n" +
    "- The `subagent` tool is globally disabled — do not use it.\n" +
    "- Do NOT rely on file conflict analysis. Dependencies are explicitly declared in DEPS.json.\n" +
    "- Read/write any files you need. Just finish and call gsd_task_complete."
  );

  return sections.join("\n\n");
}

/**
 * Check if gsd_task_complete has been recorded in the DB for this task.
 */
function isTaskCompleteInDb(taskId, contextToolkit) {
  try {
    const task = contextToolkit.db?.getTask?.(contextToolkit.mid, contextToolkit.sid, taskId);
    return task && ["complete", "done", "success", "skipped"].includes(task.status?.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Main DAG execution loop.
 * Spawns ready tasks, awaits completions, re-computes ready set,
 * and continues until all tasks are done.
 *
 * @param {object} deps          - Validated DEPS object
 * @param {object[]} allTasks    - All tasks in the slice
 * @param {object} contextToolkit - Context for task agents
 * @param {object} pi            - pi harness instance
 * @param {object} db            - GSD DB facade
 * @param {object} [widget]      - Optional dag-status widget instance
 * @param {Function} createAgentSessionFn - createAgentSession from pi-coding-agent
 * @param {AbortSignal} [abortSignal] - Signal to abort the entire DAG execution (issue 5)
 * @param {object} [sessionManager]   - Isolated SessionManager (issue 2)
 * @param {object} [settingsManager]  - Isolated SettingsManager (issue 2)
 * @param {string} [agentDir]         - Agent directory path (issue 2)
 */
export async function dagExecutionLoop(deps, allTasks, contextToolkit, pi, db, widget,
                                        createAgentSessionFn, abortSignal,
                                        sessionManager, settingsManager, agentDir, ctx) {
  if (!createAgentSessionFn) {
    throw new Error("createAgentSession function not provided to dagExecutionLoop");
  }

  const manager = new DagTaskManager();

  // Multi-tenant safe: register by sessionId, also expose as last-active for backward compat
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (sessionId) {
    pi._dagTaskManagers ??= new Map();
    pi._dagTaskManagers.set(sessionId, manager);
  }
  pi._dagTaskManager = manager;

  const doneStatuses = new Set(["complete", "done", "skipped", "success"]);

  /** @type {Set<string>} */
  const completedIds = new Set(
    allTasks.filter(t => doneStatuses.has(t.status?.toLowerCase())).map(t => t.id)
  );

  const running = new Map(); // taskId -> Promise

  widget?.start?.({ tasks: allTasks.map(t => ({ id: t.id, title: t.title, status: t.status })) });

  let stallCount = 0; // consecutive cycles with no progress

  // Single abort listener cascades to all taskAbort controllers via manager.abortAll
  const onDagAbort = () => manager.abortAll();
  if (abortSignal?.aborted) {
    onDagAbort();
  } else {
    abortSignal?.addEventListener("abort", onDagAbort, { once: true });
  }

  try {
    while (completedIds.size < allTasks.length) {
    // Check for external abort (issue 5)
    if (abortSignal?.aborted) {
      manager.abortAll();
      throw new Error("DAG execution aborted by parent signal.");
    }

    // Fail-fast: if any task suffered an infrastructure failure, abort the DAG
    if (manager.failedTasks.size > 0) {
      manager.abortAll();
      const failed = [...manager.failedTasks];
      throw new Error(`DAG infrastructure failure: task(s) [${failed.join(", ")}] cannot recover.`);
    }

    // Re-query DB to pick up task completions from background agents (issue 13)
    if (db?.getSliceTasks) {
      try {
        const freshTasks = db.getSliceTasks(contextToolkit.mid, contextToolkit.sid);
        if (freshTasks?.length === allTasks.length) {
          allTasks = freshTasks;
          const before = completedIds.size;
          for (const t of freshTasks) {
            if (doneStatuses.has(t.status?.toLowerCase()) && !completedIds.has(t.id)) {
              completedIds.add(t.id);
            }
          }
          if (completedIds.size > before) stallCount = 0;
        }
      } catch { /* ignore */ }
    }

    // Force-sync completedIds into allTasks via shallow copy (never mutate DB objects)
    allTasks = allTasks.map(t => completedIds.has(t.id) ? { ...t, status: "complete" } : t);

    // Compute ready set excluding already completed, running, and failed tasks
    const readyIds = computeReadySet(deps, allTasks)
      .filter(id => !completedIds.has(id) && !running.has(id) && !manager.failedTasks.has(id));

    // Update widget with current state
    widget?.update?.({
      tasks: allTasks.map(t => {
        let status = "ready";
        if (completedIds.has(t.id)) status = "done";
        else if (running.has(t.id)) status = "running";
        else if (manager.failedTasks.has(t.id)) status = "failed";
        else if (!readyIds.includes(t.id)) status = "blocked";
        const rec = manager.agents.get(t.id);
        let waitingOn;
        if (status === "blocked" && deps.tasks?.[t.id]?.depends_on) {
          waitingOn = deps.tasks[t.id].depends_on.filter(d => !completedIds.has(d));
        }
        return { id: t.id, title: t.title, status, waitingOn, tool: rec?.tool, startedAt: rec?.startedAt ?? null, endedAt: rec?.endedAt ?? null, elapsed: rec?.startedAt ? Date.now() - rec.startedAt : 0 };
      }),
    });

    // Spawn ready tasks
    for (const taskId of readyIds) {
      const task = allTasks.find(t => t.id === taskId);
      if (!task) continue;

      const planContent = contextToolkit.taskPlans?.[taskId] ?? `# ${task.title}\n${task.description ?? ""}`;

      // Dynamically read upstream SUMMARY.md for this task
      let taskCtx = contextToolkit;
      const depIds = deps.tasks[taskId]?.depends_on?.filter(d => completedIds.has(d)) ?? [];
      if (depIds.length > 0) {
        const summaries = [];
        for (const depId of depIds) {
          const depTask = contextToolkit.db?.getTask?.(contextToolkit.mid, contextToolkit.sid, depId);
          if (depTask) {
            const parts = [`### ${depId}`];
            if (depTask.oneLiner) parts.push(`> ${depTask.oneLiner}`);
            if (depTask.narrative) parts.push(depTask.narrative.slice(0, 1500));
            summaries.push(parts.join("\n"));
          } else {
            summaries.push(`### ${depId}\nCompleted (no details in DB).`);
          }
        }
        taskCtx = { ...contextToolkit, completedDeps: null, dynamicCompletedDeps: "## Upstream Task Results\n" + summaries.join("\n\n") };
      }

      const promise = manager.runTask(taskId, planContent, taskCtx, pi,
                                       createAgentSessionFn, sessionManager, settingsManager,
                                       agentDir, abortSignal)
        .then(() => {
          completedIds.add(taskId);
          const rec = manager.agents.get(taskId);
          if (rec) rec.endedAt = Date.now();
          running.delete(taskId);
          stallCount = 0;
        })
        .catch(err => {
          if (!abortSignal?.aborted) {
            ctx?.ui?.notify?.(`[DAG] Task ${taskId} error: ${err.message} — FAILED`, "error");
            manager.failedTasks.add(taskId);
          }
          const rec = manager.agents.get(taskId);
          if (rec) rec.endedAt = Date.now();
          running.delete(taskId);
        });

      running.set(taskId, promise);
    }

    if (running.size === 0) {
      if (completedIds.size >= allTasks.length) break;

      // No tasks running, stall guard — indefinite retry, never throw on logic errors
      stallCount++;
      if (stallCount % 10 === 0) {
        const stuck = allTasks.filter(t => !completedIds.has(t.id)).map(t => t.id);
        ctx?.ui?.notify?.(`[DAG] stalled (${stallCount} cycles), remaining: [${stuck.join(", ")}]`, "warning");
      }
      await new Promise(r => setTimeout(r, 200 * Math.min(stallCount, 10)));
      continue;
    }

    await Promise.race(running.values());
    // Small yield to let microtasks flush (issue 13)
    await new Promise(r => setImmediate(r));
  }

  return { completed: [...completedIds], total: allTasks.length };
} finally {
  widget?.stop?.();
  manager.abortAll();
  abortSignal?.removeEventListener("abort", onDagAbort);
  if (sessionId) pi._dagTaskManagers?.delete(sessionId);
  if (pi._dagTaskManager === manager) pi._dagTaskManager = null;
}
}
