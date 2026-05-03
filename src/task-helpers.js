import { mainSessionsBySessionId } from "./session-registry.js";

// Task execution helpers

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("Aborted"));
  const timer = setTimeout(resolve, ms);
  if (signal) {
    const onAbort = () => { clearTimeout(timer); reject(new Error("Aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  }
});

export const buildTaskPrompt = (taskId, planContent, contextToolkit) => {
  const sections = [`# Execute task ${taskId}`];
  sections.push(contextToolkit.milestoneContext 
    ? `## Milestone context\n${contextToolkit.milestoneContext}`
    : "## Milestone context\nNo milestone context file available.");
  sections.push(`## Slice goal\n${contextToolkit.sliceGoal}`);
  sections.push(`## Task plan\n${planContent}`);
  if (contextToolkit.dynamicCompletedDeps) sections.push(contextToolkit.dynamicCompletedDeps);
  sections.push(
    "## Execution rules (MANDATORY — follow exactly)\n" +
    "- This task runs in parallel with other tasks. Do NOT depend on other running tasks.\n" +
    "- You MUST call `gsd_task_complete` tool after finishing the task.\n" +
    "- You MUST NOT exit without calling `gsd_task_complete`.\n" +
    "- Use subagent at your discretion as needed.\n" +
    "- Do NOT rely on file conflict analysis. Dependencies are explicitly declared in DEPS.json.\n" +
    "- Read/write any files you need. Just finish and call gsd_task_complete."
  );
  return sections.join("\n\n");
};

export const isTaskCompleteInDb = (taskId, contextToolkit) => {
  try {
    const task = contextToolkit.db?.getTask?.(contextToolkit.mid, contextToolkit.sid, taskId);
    const doneStatuses = new Set(["complete", "done", "skipped", "success"]);
    return doneStatuses.has(task?.status?.toLowerCase());
  } catch { return false; }
};

export const createTaskSession = async (taskId, ctx, createAgentSessionFn) => {
  try {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    ctx?.ui?.notify?.(`[${taskId}] sessionId=${sessionId}`, "info");

    const mainSession = sessionId ? mainSessionsBySessionId.get(sessionId) : null;
    ctx?.ui?.notify?.(`[${taskId}] registry ${mainSession ? "hit" : "miss"} for session`, mainSession ? "success" : "error");

    if (!mainSession) {
      throw new Error(`Main session ${sessionId ?? "unknown"} not registered`);
    }

    const options = { cwd: ctx?.cwd ?? process.cwd() };

    if (mainSession.resourceLoader) {
      options.resourceLoader = mainSession.resourceLoader;
    }
    if (mainSession.modelRegistry) {
      options.modelRegistry = mainSession.modelRegistry;
    }
    if (mainSession.settingsManager) {
      options.settingsManager = mainSession.settingsManager;
    }
    if (mainSession.model) {
      options.model = mainSession.model;
    }
    if (mainSession.thinkingLevel) {
      options.thinkingLevel = mainSession.thinkingLevel;
    }
    if (mainSession.getActiveToolNames) {
      const activeToolNames = mainSession.getActiveToolNames();
      if (activeToolNames?.length > 0) {
        options.extraActiveToolNames = activeToolNames;
      }
    }
    if (mainSession._customTools?.length > 0) {
      options.customTools = mainSession._customTools;
    }
    if (mainSession._scopedModels?.length > 0) {
      options.scopedModels = mainSession._scopedModels;
    }
    if (Array.isArray(ctx?.tools) && ctx.tools.length > 0) {
      options.tools = ctx.tools;
    }

    const result = await createAgentSessionFn(options);
    if (!result?.session) throw new Error("session factory returned no session instance");

    const session = result.session;

    try {
      const mainExts = mainSession.resourceLoader?.getExtensions?.();
      const childExts = session.resourceLoader?.getExtensions?.();
      const mainExtCount = mainExts?.extensions?.length ?? 0;
      const childExtCount = childExts?.extensions?.length ?? 0;
      if (childExtCount < mainExtCount) {
        ctx?.ui?.notify?.(
          `[${taskId}] WARNING: child session loaded ${childExtCount} extensions vs main ${mainExtCount}. ` +
          `Guardian and other extensions may be missing. Ensure resourceLoader is inherited correctly.`,
          "warning"
        );
      }
    } catch {}
    const listeners = mainSession._eventListeners;
    if (!Array.isArray(listeners)) {
      throw new Error(`main session ${sessionId} has no event listeners`);
    }

    session.subscribe((event) => {
      const markedEvent = event && typeof event === "object"
        ? { ...event, _dagChildSession: true, _dagTaskId: taskId }
        : event;
      for (const listener of listeners) {
        listener(markedEvent);
      }
    });

    ctx?.ui?.notify?.(`[${taskId}] bridged to ${listeners.length} listeners`, "success");
    return session;
  } catch (err) {
    throw new Error(`Failed to create agent session for ${taskId}: ${err.message}`);
  }
};

export const setupSessionAbort = (session, taskAbort, record) => {
  if (!taskAbort.signal) return;
  const unsubAbort = () => { if (taskAbort.signal.aborted) session.abort?.(); };
  if (taskAbort.signal.aborted) {
    unsubAbort();
  } else {
    taskAbort.signal.addEventListener("abort", unsubAbort, { once: true });
    record.unsubscribes.push(() => taskAbort.signal.removeEventListener("abort", unsubAbort));
  }
};

const MAX_EMPTY_TURNS = 30;

export const runTaskLoop = async (session, taskId, basePrompt, contextToolkit, abortSignal, taskAbort, record, ctx) => {
  let currentPrompt = basePrompt;
  let emptyTurnCount = 0;
  let totalEmptyTurnCount = 0;

  while (true) {
    if (abortSignal?.aborted || taskAbort.signal.aborted) {
      record.status = "aborted";
      throw new Error("Task aborted");
    }

    if (totalEmptyTurnCount >= MAX_EMPTY_TURNS) {
      record.status = "failed";
      throw new Error(`Task ${taskId} exited ${MAX_EMPTY_TURNS} times without calling gsd_task_complete. Aborting.`);
    }

    try {
      await session.prompt(currentPrompt);

      // Decoupled synchronization: wait for extension handlers (like Guardian)
      // to process agent_end events and potentially initiate follow-up prompts.
      try {
        if (session._agentEventQueue) await session._agentEventQueue;
      } catch (e) {}

      // Wait if any extension actually started another streaming prompt
      while (session.isStreaming || session.agent?.isStreaming) {
        await new Promise(r => setTimeout(r, 200));
        try {
          if (session._agentEventQueue) await session._agentEventQueue;
        } catch (e) {}
      }

      if (isTaskCompleteInDb(taskId, contextToolkit)) {
        record.status = "completed";
        return;
      }

      // Check if it failed and extensions (e.g. Guardian) gave up resolving it.
      const lastMsg = session.state?.messages?.at(-1);
      if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error") {
        record.status = "failed";
        throw new Error(`Task ${taskId} failed: ${lastMsg.errorMessage}`);
      }

      currentPrompt = "You exited without calling `gsd_task_complete`. You MUST finish the task and then call gsd_task_complete.";
      totalEmptyTurnCount++;
      if (++emptyTurnCount >= 10) {
        currentPrompt = basePrompt + `\n\n**SYSTEM NOTICE**: You have exited 10 times without completing the task. Please review the task plan and call gsd_task_complete when done.`;
        emptyTurnCount = 0;
      }

      await new Promise(r => setTimeout(r, 100));

    } catch (err) {
      if (abortSignal?.aborted || taskAbort.signal.aborted) {
        record.status = "aborted";
        throw new Error("Task aborted");
      }
      record.status = "failed";
      throw new Error(`Task ${taskId} encountered fatal error: ${err.message}`);
    }
  }
};
