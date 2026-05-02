import { computeReadySet } from "./deps.js";
import { buildTaskPrompt, createTaskSession, setupSessionAbort, runTaskLoop } from "./task-helpers.js";

export class DagTaskManager {
  constructor() {
    this.agents = new Map();
    this.failedTasks = new Set();
    this.abortControllers = new Map();
  }

  async runTask(taskId, planContent, contextToolkit, createAgentSessionFn, sessionManager, settingsManager, agentDir, abortSignal, ctx) {
    if (!createAgentSessionFn) throw new Error("createAgentSession function not provided to runTask");

    const taskAbort = new AbortController();
    this.abortControllers.set(taskId, taskAbort);
    this.agents.set(taskId, { session: null, status: "starting", startedAt: Date.now(), unsubscribes: [] });

    const session = await createTaskSession(taskId, ctx, createAgentSessionFn, sessionManager, settingsManager)
      .catch(err => { this.abortControllers.delete(taskId); throw err; });

    session.setActiveToolsByName?.((session.getActiveToolNames?.() ?? []).filter(t => t !== "_wait_for_dag_completion"));

    const record = { session, status: "running", startedAt: this.agents.get(taskId)?.startedAt ?? Date.now(), unsubscribes: [] };
    this.agents.set(taskId, record);

    if (session.subscribe) {
      record.unsubscribes.push(session.subscribe(event => {
        record.tool = event.type === "tool_execution_start" ? event.toolName : null;
      }));
    }

    setupSessionAbort(session, taskAbort, record);

    try {
      await runTaskLoop(session, taskId, buildTaskPrompt(taskId, planContent, contextToolkit), contextToolkit, abortSignal, taskAbort, record);
    } finally {
      record.unsubscribes.forEach(unsub => { try { unsub(); } catch {} });
      record.unsubscribes = [];
      this.abortControllers.delete(taskId);
    }
  }

  abortAll() {
    for (const [id, ctrl] of this.abortControllers) ctrl.abort();
    this.abortControllers.clear();
  }

  getStatus() {
    return [...this.agents.entries()].map(([id, r]) => ({
      id,
      status: r.status,
      elapsed: Date.now() - r.startedAt,
    }));
  }
}

const syncDbState = (db, contextToolkit, allTasks, completedIds) => {
  if (!db?.getSliceTasks) return allTasks;
  try {
    const freshTasks = db.getSliceTasks(contextToolkit.mid, contextToolkit.sid);
    if (freshTasks?.length !== allTasks.length) return allTasks;
    const doneStatuses = new Set(["complete", "done", "skipped", "success"]);
    for (const t of freshTasks) {
      if (doneStatuses.has(t.status?.toLowerCase()) && !completedIds.has(t.id)) {
        completedIds.add(t.id);
      }
    }
    return freshTasks;
  } catch { return allTasks; }
};

const spawnReadyTasks = (readyIds, deps, allTasks, running, completedIds, manager, contextToolkit, createAgentSessionFn, abortSignal, sessionManager, settingsManager, agentDir, ctx, failedIds) => {
  for (const taskId of readyIds) {
    const planContent = contextToolkit.taskPlans?.[taskId] ?? `No plan found for ${taskId}`;
    const depIds = deps.tasks[taskId]?.depends_on ?? [];
    const completedDepTitles = depIds.map(d => allTasks.find(t => t.id === d)?.title ?? d).filter(Boolean);
    const dynamicToolkit = { ...contextToolkit, dynamicCompletedDeps: completedDepTitles.length > 0 ? `## Completed dependencies\n${completedDepTitles.map(t => `- ${t}`).join("\n")}` : undefined };

    const promise = manager.runTask(taskId, planContent, dynamicToolkit, createAgentSessionFn, sessionManager, settingsManager, agentDir, abortSignal, ctx)
      .then(() => {
        completedIds.add(taskId);
        const rec = manager.agents.get(taskId);
        if (rec) rec.endedAt = Date.now();
        running.delete(taskId);
      })
      .catch(err => {
        manager.failedTasks.add(taskId);
        failedIds.add(taskId);
        ctx?.ui?.notify?.(`[DAG] Task ${taskId} error: ${err.message} — FAILED`, "error");
        running.delete(taskId);
      });
    running.set(taskId, promise);
  }
};

const initDagState = (allTasks, sessionId, dagTaskManagers) => {
  const manager = sessionId && dagTaskManagers?.get(sessionId) || new DagTaskManager();
  if (sessionId && dagTaskManagers && !dagTaskManagers.has(sessionId)) dagTaskManagers.set(sessionId, manager);
  
  const completedIds = new Set();
  const doneStatuses = new Set(["complete", "done", "skipped", "success"]);
  allTasks.forEach(t => { if (doneStatuses.has(t.status?.toLowerCase())) completedIds.add(t.id); });
  
  return { manager, completedIds, failedIds: new Set(), running: new Map(), stallCount: 0 };
};

const checkDagAbort = (abortSignal, manager) => {
  if (abortSignal?.aborted) throw new Error("DAG execution aborted by parent signal.");
  if (manager.failedTasks.size > 0) {
    manager.abortAll();
    throw new Error(`DAG infrastructure failure: task(s) [${[...manager.failedTasks].join(", ")}] cannot recover.`);
  }
};

const checkDeadlock = (readyIds, running, allTasks, completedIds, failedIds) => {
  if (readyIds.length === 0 && running.size === 0) {
    const allDone = allTasks.every(t => completedIds.has(t.id) || failedIds.has(t.id));
    if (allDone) return true;
    const stuck = allTasks.filter(t => !completedIds.has(t.id) && !failedIds.has(t.id)).map(t => t.id);
    throw new Error(`DAG deadlock: no tasks ready, none running, but incomplete: [${stuck.join(", ")}]`);
  }
  return false;
};

const handleStall = async (readyIds, running, stallCount, allTasks, completedIds, ctx) => {
  if (readyIds.length > 0 || running.size === 0) return 0;
  const newStallCount = stallCount + 1;
  if (newStallCount >= 5) {
    const stuck = allTasks.filter(t => !completedIds.has(t.id) && !running.has(t.id)).map(t => t.id);
    ctx?.ui?.notify?.(`[DAG] stalled (${newStallCount} cycles), remaining: [${stuck.join(", ")}]`, "warning");
  }
  await new Promise(r => setTimeout(r, 200 * Math.min(newStallCount, 10)));
  return newStallCount;
};

export async function dagExecutionLoop(deps, allTasks, contextToolkit, db, widget, createAgentSessionFn, abortSignal, sessionManager, settingsManager, agentDir, ctx, dagTaskManagers) {
  if (!createAgentSessionFn) throw new Error("createAgentSession function not provided to dagExecutionLoop");

  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const { manager, completedIds, failedIds, running, stallCount: initialStall } = initDagState(allTasks, sessionId, dagTaskManagers);
  let stallCount = initialStall;

  const onDagAbort = () => manager.abortAll();
  if (abortSignal) abortSignal.addEventListener("abort", onDagAbort);

  try {
    while (completedIds.size < allTasks.length) {
      checkDagAbort(abortSignal, manager);
      allTasks = syncDbState(db, contextToolkit, allTasks, completedIds);

      const readyIds = computeReadySet(deps, allTasks).filter(id => !completedIds.has(id) && !running.has(id) && !manager.failedTasks.has(id));

      if (checkDeadlock(readyIds, running, allTasks, completedIds, failedIds)) break;

      stallCount = await handleStall(readyIds, running, stallCount, allTasks, completedIds, ctx);
      if (readyIds.length === 0) continue;

      spawnReadyTasks(readyIds, deps, allTasks, running, completedIds, manager, contextToolkit, createAgentSessionFn, abortSignal, sessionManager, settingsManager, agentDir, ctx, failedIds);
      stallCount = 0;
      await Promise.race(running.values());
      await new Promise(r => setImmediate(r));
    }

    return { completed: [...completedIds], total: allTasks.length };
  } finally {
    widget?.stop?.();
    manager.abortAll();
    abortSignal?.removeEventListener("abort", onDagAbort);
    if (sessionId && dagTaskManagers) dagTaskManagers.delete(sessionId);
  }
}
