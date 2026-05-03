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

export const createTaskSession = async (taskId, ctx, createAgentSessionFn, mainSessionCtx) => {
  try {
    // DEBUG: Check what we received
    ctx?.ui?.notify?.(`[${taskId}] createTaskSession called`, 'info');
    ctx?.ui?.notify?.(`[${taskId}] mainSessionCtx exists: ${!!mainSessionCtx}`, 'info');
    ctx?.ui?.notify?.(`[${taskId}] mainSessionCtx.ui exists: ${!!mainSessionCtx?.ui}`, 'info');
    ctx?.ui?.notify?.(`[${taskId}] ctx.session exists: ${!!ctx?.session}`, 'info');
    
    const options = { cwd: ctx?.cwd ?? process.cwd() };
    const extraActiveToolNames = [
      ...(Array.isArray(ctx?.extraActiveToolNames) ? ctx.extraActiveToolNames : []),
      ...(ctx?.session?.getActiveToolNames?.() ?? []),
    ].filter(Boolean);

    const SESSION_OPTION_KEYS = [
      ["tools", ctx?.tools],
      ["extraActiveToolNames", extraActiveToolNames.length > 0 ? [...new Set(extraActiveToolNames)] : undefined],
      ["model", ctx?.session?.getModel?.()],
      ["thinkingLevel", ctx?.session?.getThinkingLevel?.()],
      ["resourceLoader", ctx?.resourceLoader],
      ["agentDir", ctx?.agentDir],
      ["modelRegistry", ctx?.modelRegistry],
      ["settingsManager", ctx?.settingsManager],
    ];
    for (const [key, value] of SESSION_OPTION_KEYS) {
      if (value !== undefined && value !== null) options[key] = value;
    }

    const result = await createAgentSessionFn(options);
    if (!result?.session) {
      throw new Error("session factory returned no session instance");
    }
    
    const session = result.session;
    
    // MONKEY PATCH: Make task session's events visible to main session's Interactive Mode
    if (mainSessionCtx?.ui && ctx?.session) {
      bridgeSessionEvents(session, ctx.session, taskId, mainSessionCtx.ui);
    }
    
    return session;
  } catch (err) {
    throw new Error(`Failed to create agent session for ${taskId}: ${err.message}`);
  }
};

/**
 * BLACK MAGIC: Bridge task session's events to main session's event listeners.
 * This makes Interactive Mode render task session's tools as if they were main session's.
 */
function bridgeSessionEvents(taskSession, mainSession, taskId, mainUI) {
  // Access main session's private _eventListeners array (black magic!)
  const mainListeners = mainSession._eventListeners;
  
  mainUI.notify?.(`[${taskId}] DEBUG: _eventListeners type: ${typeof mainListeners}, isArray: ${Array.isArray(mainListeners)}, length: ${mainListeners?.length}`, 'info');
  
  if (!Array.isArray(mainListeners) || mainListeners.length === 0) {
    mainUI.notify?.(`[${taskId}] FALLBACK: Cannot access event listeners (${mainListeners?.length || 0} found) - using notify()`, 'warning');
    fallbackToNotify(taskSession, taskId, mainUI);
    return;
  }
  
  mainUI.notify?.(`[${taskId}] SUCCESS: Bridging to ${mainListeners.length} main session listeners`, 'success');
  
  // Subscribe to task session and forward ALL events to main session's listeners
  taskSession.subscribe((event) => {
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      mainUI.notify?.(`[${taskId}] Event: ${event.type} - ${event.toolName}`, 'info');
    }
    
    // Prefix tool names with [taskId] so they're distinguishable
    let modifiedEvent = event;
    
    if (event.type === 'tool_execution_start') {
      modifiedEvent = {
        ...event,
        toolName: `[${taskId}] ${event.toolName}`,
      };
    } else if (event.type === 'tool_execution_end') {
      modifiedEvent = {
        ...event,
        toolName: `[${taskId}] ${event.toolName}`,
      };
    }
    
    // Forward to ALL main session's listeners (including Interactive Mode)
    let forwardedCount = 0;
    for (const listener of mainListeners) {
      try {
        listener(modifiedEvent);
        forwardedCount++;
      } catch (err) {
        mainUI.notify?.(`[${taskId}] Listener error: ${err.message}`, 'error');
      }
    }
    
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      mainUI.notify?.(`[${taskId}] Forwarded to ${forwardedCount} listeners`, 'info');
    }
  });
}

/**
 * Fallback: use notify() if we can't access event listeners
 */
function fallbackToNotify(session, taskId, mainUI) {
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      mainUI.notify?.(`[${taskId}] ▸ ${event.toolName}`, 'info');
    } else if (event.type === 'tool_execution_end') {
      const status = event.error ? '✗' : '✓';
      const duration = event.durationMs ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : '';
      mainUI.notify?.(`[${taskId}] ${status} ${event.toolName}${duration}`, event.error ? 'warning' : 'info');
    }
  });
}

/**
 * Monkey patch: inject task session's messages into main session's message stream.
 * This makes the main session's interactive mode render task output automatically.
 */

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
