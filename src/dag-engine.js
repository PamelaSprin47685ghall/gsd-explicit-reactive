import { computeReadySet } from "./deps.js";

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

    const onParentAbort = () => { taskAbort.abort(); };
    abortSignal?.addEventListener("abort", onParentAbort, { once: true });

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
      abortSignal?.removeEventListener("abort", onParentAbort);
      this.abortControllers.delete(taskId);
      throw new Error(`Failed to create agent session for ${taskId}: ${err.message}`);
    }

    const toolNames = session.getActiveToolNames?.() ?? [];
    session.setActiveToolsByName?.(toolNames.filter(t => t !== "subagent"));

    const record = { session, status: "running", startedAt: Date.now(), unsubscribes: [] };
    this.agents.set(taskId, record);

    // Subscribe to tool events and store the unsubscribe function (issue 11)
    if (session.subscribe) {
      const unsub = session.subscribe(event => {
        if (event.type === "tool_execution_start") {
          pi.notifyTaskActivity?.(taskId, event.toolName, event.args);
        }
      });
      record.unsubscribes.push(unsub);
    }

    // Forward task abort signal to session
    if (taskAbort.signal) {
      const unsubAbort = () => {
        if (taskAbort.signal.aborted) session.abort?.();
      };
      taskAbort.signal.addEventListener("abort", unsubAbort, { once: true });
      record.unsubscribes.push(() =>
        taskAbort.signal.removeEventListener("abort", unsubAbort)
      );
    }

    let currentPrompt = buildTaskPrompt(taskId, planContent, contextToolkit);

    try {
      while (true) {
        // Hard abort check: parent signal triggered
        if (abortSignal?.aborted || taskAbort.signal.aborted) {
          record.status = "aborted";
          return;
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
        } catch (err) {
          currentPrompt =
            `Previous attempt failed with error: ${err.message}. ` +
            "Please try another approach. Do not give up.";
        }
      }
    } finally {
      abortSignal?.removeEventListener("abort", onParentAbort);
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

  if (contextToolkit.completedDeps?.length > 0) {
    sections.push("## Completed dependencies\n" + contextToolkit.completedDeps.join("\n"));
  }

  if (contextToolkit.depsError) {
    sections.push(
      `## Error / Retry context\n` +
      `Previous DEPS validation error:\n${JSON.stringify(contextToolkit.depsError, null, 2)}`
    );
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
    return task && ["complete", "done", "success"].includes(task.status?.toLowerCase());
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
                                        sessionManager, settingsManager, agentDir) {
  if (!createAgentSessionFn) {
    throw new Error("createAgentSession function not provided to dagExecutionLoop");
  }

  const manager = new DagTaskManager();
  pi._dagTaskManager = manager; // expose for session_shutdown (issue 9)
  const doneStatuses = new Set(["complete", "done", "skipped", "success"]);

  /** @type {Set<string>} */
  const completedIds = new Set(
    allTasks.filter(t => doneStatuses.has(t.status?.toLowerCase())).map(t => t.id)
  );

  const running = new Map(); // taskId -> Promise

  widget?.start?.({ tasks: allTasks.map(t => ({ id: t.id, title: t.title, status: t.status })) });

  let stallCount = 0; // consecutive cycles with no progress (issue 13)
  const MAX_STALL = 5;

  while (completedIds.size < allTasks.length) {
    // Check for external abort (issue 5)
    if (abortSignal?.aborted) {
      manager.abortAll();
      throw new Error("DAG execution aborted by parent signal.");
    }

    // Re-query DB to pick up task completions from background agents (issue 13)
    if (db?.getSliceTasks) {
      try {
        const freshTasks = db.getSliceTasks(contextToolkit.mid, contextToolkit.sid);
        if (freshTasks?.length === allTasks.length) {
          const before = completedIds.size;
          for (const t of freshTasks) {
            if (doneStatuses.has(t.status?.toLowerCase()) && !completedIds.has(t.id)) {
              completedIds.add(t.id);
              running.delete(t.id);
            }
          }
          if (completedIds.size > before) stallCount = 0;
        }
      } catch { /* ignore */ }
    }

    // Compute ready set excluding already completed and already running
    const readyIds = computeReadySet(deps, allTasks)
      .filter(id => !completedIds.has(id) && !running.has(id));

    // Update widget with current state
    widget?.update?.({
      tasks: allTasks.map(t => {
        let status = "ready";
        if (completedIds.has(t.id)) status = "done";
        else if (running.has(t.id)) status = "running";
        else if (manager.failedTasks.has(t.id)) status = "failed";
        else if (!readyIds.includes(t.id)) status = "blocked";
        const rec = manager.agents.get(t.id);
        return { id: t.id, title: t.title, status, elapsed: rec?.startedAt ? Date.now() - rec.startedAt : 0 };
      }),
    });

    // Spawn ready tasks
    for (const taskId of readyIds) {
      const task = allTasks.find(t => t.id === taskId);
      if (!task) continue;

      const planContent = contextToolkit.taskPlans?.[taskId] ?? `# ${task.title}\n${task.description ?? ""}`;

      const promise = manager.runTask(taskId, planContent, contextToolkit, pi,
                                       createAgentSessionFn, sessionManager, settingsManager,
                                       agentDir, abortSignal)
        .then(() => {
          completedIds.add(taskId);
          running.delete(taskId);
          stallCount = 0;
        })
        .catch(err => {
          console.error(`[DAG] Task ${taskId} failed despite retries: ${err.message}`);
          manager.failedTasks.add(taskId);
          running.delete(taskId);
        });

      running.set(taskId, promise);
    }

    if (running.size === 0) {
      if (completedIds.size >= allTasks.length) break;

      // If there are failed tasks that block downstream, throw instead of silent exit (issue 4)
      if (manager.failedTasks.size > 0) {
        const failed = [...manager.failedTasks];
        const blocked = allTasks
          .filter(t => !completedIds.has(t.id) && !failed.includes(t.id))
          .map(t => t.id);
        throw new Error(
          `DAG execution failed: task(s) [${failed.join(", ")}] exhausted retries.` +
          (blocked.length > 0 ? ` Downstream tasks [${blocked.join(", ")}] blocked.` : "")
        );
      }

      // No tasks running, none failed, but tasks remain — could be race (issue 13)
      stallCount++;
      if (stallCount >= MAX_STALL) {
        const stuck = allTasks.filter(t => !completedIds.has(t.id)).map(t => t.id);
        throw new Error(
          `DAG stalled: no forward progress after ${MAX_STALL} cycles. ` +
          `Remaining tasks: [${stuck.join(", ")}].`
        );
      }
      // Yield and retry
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    await Promise.race(running.values());
    // Small yield to let microtasks flush (issue 13)
    await new Promise(r => setImmediate(r));
  }

  widget?.stop?.();

  return { completed: [...completedIds], total: allTasks.length };
}
