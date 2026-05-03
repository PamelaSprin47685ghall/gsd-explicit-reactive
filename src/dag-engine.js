import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { computeReadySet } from './deps.js'
import {
  buildTaskPrompt,
  createTaskSession,
  setupSessionAbort,
  runTaskLoop,
} from './task-helpers.js'

export class DagTaskManager {
  constructor() {
    this.agents = new Map()
    this.failedTasks = new Set()
    this.abortControllers = new Map()
  }

  async runTask(
    taskId,
    planContent,
    dynamicToolkit,
    createAgentSessionFn,
    abortSignal,
    onUpdate,
    ctx,
  ) {
    if (!createAgentSessionFn)
      throw new Error('createAgentSession function not provided to runTask')

    const taskAbort = new AbortController()
    this.abortControllers.set(taskId, taskAbort)

    try {
      const { session, cleanup } = await createTaskSession(
        taskId,
        ctx,
        createAgentSessionFn,
      )

      const availableTools = session.getActiveToolNames?.() ?? []
      const requiredTools = ['gsd_task_complete']
      const optionalTools = ['manage_todo_list', 'loop_control']
      const missingOptionalTools = optionalTools.filter(
        (toolName) => !availableTools.includes(toolName),
      )
      if (missingOptionalTools.length > 0) {
        ctx?.ui?.notify?.(
          `[${taskId}] Optional extension tools unavailable in task session: ${missingOptionalTools.join(', ')}`,
          'warning',
        )
      }

      if (
        !requiredTools.some((toolName) => availableTools.includes(toolName)) &&
        !availableTools.includes('gsd_complete_task')
      ) {
        const errorMsg = `Task session for ${taskId} missing gsd_task_complete tool. Available: ${availableTools.join(', ')}`
        ctx?.ui?.notify?.(errorMsg, 'error')
        throw new Error(errorMsg)
      }

      session.setActiveToolsByName?.(
        (session.getActiveToolNames?.() ?? []).filter(
          (t) => t !== '_wait_for_dag_completion',
        ),
      )

      const record = {
        session,
        status: 'running',
        startedAt: Date.now(),
        unsubscribes: [],
      }
      this.agents.set(taskId, record)

      try {
        if (session.subscribe) {
          record.unsubscribes.push(
            session.subscribe((event) => {
              if (event.type === 'tool_execution_start') {
                record.tool = event.toolName
              }
            }),
          )
        }
      } catch (subErr) {
        ctx?.ui?.notify?.(
          `[${taskId}] Failed to subscribe to session events: ${subErr.message}`,
          'warning',
        )
      }

      setupSessionAbort(session, taskAbort, record)

      await runTaskLoop(
        session,
        taskId,
        buildTaskPrompt(taskId, planContent, dynamicToolkit),
        dynamicToolkit,
        abortSignal,
        taskAbort,
        record,
        ctx,
      )
    } finally {
      try {
        cleanup?.()
      } catch {}
      const rec = this.agents.get(taskId)
      if (rec) {
        rec.unsubscribes?.forEach((unsub) => {
          try {
            unsub()
          } catch {}
        })
      }
      this.agents.delete(taskId)
      this.abortControllers.delete(taskId)
    }
  }

  abortAll() {
    for (const [id, ctrl] of this.abortControllers) ctrl.abort()
    this.abortControllers.clear()
  }

  getStatus() {
    return [...this.agents.entries()].map(([id, r]) => ({
      id,
      status: r.status,
      elapsed: Date.now() - r.startedAt,
    }))
  }
}

const syncDbState = (db, contextToolkit, allTasks, completedIds, ctx) => {
  if (!db?.getSliceTasks) return allTasks
  try {
    const freshTasks = db.getSliceTasks(contextToolkit.mid, contextToolkit.sid)
    if (!Array.isArray(freshTasks) || freshTasks.length !== allTasks.length) {
      return allTasks
    }
    const doneStatuses = new Set(['complete', 'done', 'skipped', 'success'])
    for (const t of freshTasks) {
      if (
        doneStatuses.has(t.status?.toLowerCase()) &&
        !completedIds.has(t.id)
      ) {
        completedIds.add(t.id)
      }
    }
    return freshTasks
  } catch (err) {
    ctx?.ui?.notify?.(`[DAG] DB sync failed: ${err.message}`, 'warning')
    return allTasks
  }
}

const spawnReadyTasks = (
  readyIds,
  deps,
  allTasks,
  running,
  completedIds,
  manager,
  contextToolkit,
  createAgentSessionFn,
  abortSignal,
  onUpdate,
  ctx,
  failedIds,
) => {
  for (const taskId of readyIds) {
    const planContent =
      contextToolkit.taskPlans?.[taskId] ?? `No plan found for ${taskId}`
    const depIds = deps.tasks[taskId]?.depends_on ?? []
    const completedDepTitles = depIds
      .map((d) => allTasks.find((t) => t.id === d)?.title ?? d)
      .filter(Boolean)
    const dynamicToolkit = {
      ...contextToolkit,
      dynamicCompletedDeps:
        completedDepTitles.length > 0
          ? `## Completed dependencies\n${completedDepTitles.map((t) => `- ${t}`).join('\n')}`
          : undefined,
    }

    const promise = manager
      .runTask(
        taskId,
        planContent,
        dynamicToolkit,
        createAgentSessionFn,
        abortSignal,
        onUpdate,
        ctx,
      )
      .then(() => {
        completedIds.add(taskId)
        const rec = manager.agents.get(taskId)
        if (rec) rec.endedAt = Date.now()
        running.delete(taskId)
      })
      .catch((err) => {
        // Task aborted by parent (user cancellation or DAG shutdown).
        // Do NOT count as a failure — no state rollback, no REPLAN-TRIGGER.
        if (
          err.message === 'Task aborted' ||
          err.message === 'Task aborted by parent'
        ) {
          running.delete(taskId)
          return
        }
        ctx?.ui?.notify?.(
          `Task ${taskId} failed: ${err.message}. Aborting DAG.`,
          'error',
        )
        manager.failedTasks.add(taskId)
        failedIds.add(taskId)
        running.delete(taskId)
      })
    running.set(taskId, promise)
  }
}

const initDagState = (allTasks, sessionId, dagTaskManagers) => {
  let manager = sessionId && dagTaskManagers?.get(sessionId)
  if (!manager) {
    manager = new DagTaskManager()
  } else {
    manager.abortAll()
    manager.agents.clear()
    manager.failedTasks.clear()
    manager.abortControllers.clear()
  }
  if (sessionId && dagTaskManagers && !dagTaskManagers.has(sessionId))
    dagTaskManagers.set(sessionId, manager)

  const completedIds = new Set()
  const doneStatuses = new Set(['complete', 'done', 'skipped', 'success'])
  allTasks.forEach((t) => {
    if (doneStatuses.has(t.status?.toLowerCase())) completedIds.add(t.id)
  })

  return {
    manager,
    completedIds,
    failedIds: new Set(),
    running: new Map(),
    stallCount: 0,
  }
}

const checkDagAbort = (abortSignal, manager) => {
  if (abortSignal?.aborted)
    throw new Error('DAG execution aborted by parent signal.')
  // Individual task failures are handled by spawnReadyTasks catch.
  // We no longer abort all siblings on a single task failure.
}

const checkDeadlock = (
  readyIds,
  running,
  allTasks,
  completedIds,
  failedIds,
) => {
  if (readyIds.length === 0 && running.size === 0) {
    const allDone = allTasks.every(
      (t) => completedIds.has(t.id) || failedIds.has(t.id),
    )
    if (allDone) return true
    const stuck = allTasks
      .filter((t) => !completedIds.has(t.id) && !failedIds.has(t.id))
      .map((t) => t.id)
    const failedMsg =
      failedIds.size > 0 ? ` Failed tasks: [${[...failedIds].join(', ')}].` : ''
    throw new Error(
      `DAG stuck: no tasks ready, none running, but incomplete: [${stuck.join(', ')}].${failedMsg} Triggering slice replan.`,
    )
  }
  return false
}

const handleStall = async (
  readyIds,
  running,
  stallCount,
  allTasks,
  completedIds,
  ctx,
) => {
  if (readyIds.length > 0 || running.size === 0) return 0
  const newStallCount = stallCount + 1
  if (newStallCount >= 5) {
    const stuck = allTasks
      .filter((t) => !completedIds.has(t.id) && !running.has(t.id))
      .map((t) => t.id)
    ctx?.ui?.notify?.(
      `DAG stalled (${newStallCount} cycles) — waiting for ${stuck.length} remaining task(s)`,
      'warning',
    )
  }
  await new Promise((r) => setTimeout(r, 200 * Math.min(newStallCount, 10)))
  return newStallCount
}

const emitDagRuntimeLog = (contextToolkit, payload, ctx) => {
  try {
    const mid = contextToolkit?.mid ?? 'unknown-mid'
    const sid = contextToolkit?.sid ?? 'unknown-slice'
    ctx?.ui?.notify?.(`[dag] ${mid}/${sid} ${JSON.stringify(payload)}`, 'info')
  } catch {}
}

export async function dagExecutionLoop(
  deps,
  allTasks,
  contextToolkit,
  db,
  widget,
  createAgentSessionFn,
  abortSignal,
  onUpdate,
  ctx,
  dagTaskManagers,
) {
  if (!createAgentSessionFn)
    throw new Error(
      'createAgentSession function not provided to dagExecutionLoop',
    )

  const sessionId = ctx?.sessionManager?.getSessionId?.()
  const {
    manager,
    completedIds,
    failedIds,
    running,
    stallCount: initialStall,
  } = initDagState(allTasks, sessionId, dagTaskManagers)
  let stallCount = initialStall
  let dispatchCycles = 0
  let peakRunning = 0

  const onDagAbort = () => manager.abortAll()
  if (abortSignal) abortSignal.addEventListener('abort', onDagAbort)

  const updateWidget = () => {
    if (!widget) return
    const currentReady = computeReadySet(deps, allTasks, completedIds)
    const tasks = allTasks.map((t) => {
      const rec = manager.agents.get(t.id)
      let status = 'pending'
      if (completedIds.has(t.id)) status = 'done'
      else if (failedIds.has(t.id)) status = 'failed'
      else if (running.has(t.id)) status = 'running'
      else if (currentReady.includes(t.id)) status = 'ready'

      return {
        id: t.id,
        title: t.title,
        status,
        tool: rec?.tool,
        startedAt: rec?.startedAt,
        endedAt: rec?.endedAt,
        waitingOn:
          deps.tasks[t.id]?.depends_on?.filter((d) => !completedIds.has(d)) ??
          [],
      }
    })
    if (!widget.isActive?.()) widget.start?.({ tasks })
    else widget.update?.({ tasks })
  }

  const widgetInterval = setInterval(updateWidget, 1000)

  try {
    updateWidget()
    while (completedIds.size < allTasks.length) {
      checkDagAbort(abortSignal, manager)
      allTasks = syncDbState(db, contextToolkit, allTasks, completedIds, ctx)

      const readyIds = computeReadySet(deps, allTasks, completedIds).filter(
        (id) =>
          !completedIds.has(id) &&
          !running.has(id) &&
          !manager.failedTasks.has(id),
      )

      emitDagRuntimeLog(
        contextToolkit,
        {
          event: 'tick',
          completed: completedIds.size,
          total: allTasks.length,
          running: running.size,
          readyCount: readyIds.length,
          ready: readyIds,
          failed: manager.failedTasks.size,
        },
        ctx,
      )

      if (checkDeadlock(readyIds, running, allTasks, completedIds, failedIds))
        break

      stallCount = await handleStall(
        readyIds,
        running,
        stallCount,
        allTasks,
        completedIds,
        ctx,
      )
      if (readyIds.length === 0) continue

      ctx?.ui?.notify?.(
        `[DAG] Dispatching ${readyIds.length} task(s): ${readyIds.join(', ')}`,
        'info',
      )
      dispatchCycles += 1
      spawnReadyTasks(
        readyIds,
        deps,
        allTasks,
        running,
        completedIds,
        manager,
        contextToolkit,
        createAgentSessionFn,
        abortSignal,
        onUpdate,
        ctx,
        failedIds,
      )
      peakRunning = Math.max(peakRunning, running.size)
      emitDagRuntimeLog(
        contextToolkit,
        {
          event: 'spawn',
          cycle: dispatchCycles,
          spawned: readyIds,
          runningAfterSpawn: running.size,
          peakRunning,
        },
        ctx,
      )
      updateWidget()
      stallCount = 0
      if (running.size > 0) {
        // Wait for any running task to settle, then re-evaluate the ready set.
        await Promise.race([...running.values()])
      }
      updateWidget()
      await new Promise((r) => setImmediate(r))
    }

    updateWidget()
    emitDagRuntimeLog(
      contextToolkit,
      {
        event: 'completed',
        completed: completedIds.size,
        total: allTasks.length,
        dispatchCycles,
        peakRunning,
        failed: manager.failedTasks.size,
      },
      ctx,
    )
    if (failedIds.size > 0) {
      throw new Error(
        `DAG completed with permanent task failures: [${[...failedIds].join(', ')}]`,
      )
    }
    ctx?.ui?.notify?.(
      `[DAG] Completed ${completedIds.size}/${allTasks.length} tasks (peak ${peakRunning} parallel).`,
      'success',
    )
    return { completed: [...completedIds], total: allTasks.length }
  } finally {
    clearInterval(widgetInterval)
    widget?.stop?.()
    manager.abortAll()
    abortSignal?.removeEventListener('abort', onDagAbort)
    if (sessionId && dagTaskManagers) dagTaskManagers.delete(sessionId)

    if (abortSignal?.aborted) {
      // Clean up REPLAN-TRIGGER if it exists from a prior aborted run
      try {
        const triggerPath = join(
          contextToolkit.basePath,
          '.gsd',
          'milestones',
          contextToolkit.mid,
          'slices',
          contextToolkit.sid,
          'REPLAN-TRIGGER',
        )
        if (existsSync(triggerPath)) unlinkSync(triggerPath)
      } catch {}
      ctx?.ui?.notify?.(
        '[DAG] Aborted — state preserved for repair flow.',
        'info',
      )
      return { completed: [...completedIds], total: allTasks.length }
    }

    if (failedIds.size > 0) {
      for (const taskId of failedIds) {
        try {
          db?.updateTaskStatus?.(
            contextToolkit.mid,
            contextToolkit.sid,
            taskId,
            'pending',
          )
        } catch (rollbackErr) {
          ctx?.ui?.notify?.(
            `Failed to roll back ${taskId} to pending: ${rollbackErr.message}`,
            'warning',
          )
        }
      }
      try {
        const triggerPath = join(
          contextToolkit.basePath,
          '.gsd',
          'milestones',
          contextToolkit.mid,
          'slices',
          contextToolkit.sid,
          'REPLAN-TRIGGER',
        )
        writeFileSync(
          triggerPath,
          JSON.stringify({
            failedTasks: [...failedIds],
            triggeredAt: new Date().toISOString(),
          }),
          'utf-8',
        )
      } catch (err) {
        ctx?.ui?.notify?.(
          `[DAG] CRITICAL: Failed to write REPLAN-TRIGGER — automatic replan will not trigger: ${err.message}`,
          'error',
        )
      }
    } else {
      try {
        const triggerPath = join(
          contextToolkit.basePath,
          '.gsd',
          'milestones',
          contextToolkit.mid,
          'slices',
          contextToolkit.sid,
          'REPLAN-TRIGGER',
        )
        if (existsSync(triggerPath)) unlinkSync(triggerPath)
      } catch (err) {
        ctx?.ui?.notify?.(
          `[DAG] Failed to clean REPLAN-TRIGGER: ${err.message}`,
          'warning',
        )
      }
    }
  }
}
