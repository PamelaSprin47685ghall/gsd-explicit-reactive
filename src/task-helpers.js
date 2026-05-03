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

    // 从主会话强继承所有关键运行时，确保子会话与主会话完全等同
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
    // 继承 customTools（private 字段，JS 可访问但加防御）
    if (mainSession._customTools?.length > 0) {
      options.customTools = mainSession._customTools;
    }
    // 继承 scopedModels（private 字段）
    if (mainSession._scopedModels?.length > 0) {
      options.scopedModels = mainSession._scopedModels;
    }
    // 保留 ctx 传入的 tools（SDK 自定义工具）
    if (Array.isArray(ctx?.tools) && ctx.tools.length > 0) {
      options.tools = ctx.tools;
    }

    const result = await createAgentSessionFn(options);
    if (!result?.session) throw new Error("session factory returned no session instance");

    const session = result.session;

    // 防回退断言：检查子会话扩展加载数量是否与主会话一致
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
      for (const listener of listeners) {
        listener(event);
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

const FATAL_ERROR_PATTERNS = ["session closed"];
const MAX_RETRIES = 20;
const MAX_EMPTY_TURNS = 30;

export const runTaskLoop = async (session, taskId, basePrompt, contextToolkit, abortSignal, taskAbort, record, ctx) => {
  let currentPrompt = basePrompt;
  let retryCount = 0;
  let emptyTurnCount = 0;
  let totalEmptyTurnCount = 0;

  while (true) {
    if (abortSignal?.aborted || taskAbort.signal.aborted) {
      record.status = "aborted";
      throw new Error("Task aborted");
    }

    if (retryCount >= MAX_RETRIES) {
      record.status = "failed";
      throw new Error(`Task ${taskId} exceeded maximum retry count (${MAX_RETRIES}). Last error was persistent.`);
    }
    if (totalEmptyTurnCount >= MAX_EMPTY_TURNS) {
      record.status = "failed";
      throw new Error(`Task ${taskId} exited ${MAX_EMPTY_TURNS} times without calling gsd_task_complete. Aborting.`);
    }

    try {
      if (retryCount > 0) {
        ctx?.ui?.notify?.(`[${taskId}] Task agent retry (attempt ${retryCount + 1})`, "warning");
      }
      await session.prompt(currentPrompt);
      if (isTaskCompleteInDb(taskId, contextToolkit)) {
        record.status = "completed";
        return;
      }
      currentPrompt = "You exited without calling `gsd_task_complete`. You MUST finish the task and then call gsd_task_complete.";
      totalEmptyTurnCount++;
      if (++emptyTurnCount >= 10) {
        currentPrompt = basePrompt + `\n\n**SYSTEM NOTICE**: You have exited 10 times without completing the task. Please review the task plan and call gsd_task_complete when done.`;
        emptyTurnCount = 0;
      }
      await new Promise(r => setTimeout(r, 0));
    } catch (err) {
      if (abortSignal?.aborted || taskAbort.signal.aborted) {
        record.status = "aborted";
        throw new Error("Task aborted");
      }

      const errMsg = err?.message ?? String(err);
      const isFatal = FATAL_ERROR_PATTERNS.some(p => errMsg.toLowerCase().includes(p));
      if (isFatal) {
        record.status = "failed";
        throw new Error(`Task ${taskId} encountered fatal error: ${errMsg}`);
      }

      emptyTurnCount = 0;
      currentPrompt = basePrompt + `\n\n**SYSTEM ERROR ON PREVIOUS ATTEMPT**:\n${errMsg}\nPlease try another approach. Do not give up.`;
      await sleep(Math.min(2000 * Math.pow(2, retryCount++), 30000), taskAbort.signal).catch(() => {});
    }
  }
};
