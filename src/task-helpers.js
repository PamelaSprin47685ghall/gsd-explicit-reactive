import { mainSessionsBySessionId } from './session-registry.js'

// Output serialization gate: ensures one task's turn is not interleaved with another's.
class TurnOutputGate {
  constructor() {
    this.owner = null // taskId currently holding the output channel
    this.buffers = new Map() // taskId -> event[]
    this.listeners = []
  }

  handleEvent(event, taskId) {
    const isTurnStart = event?.type === 'turn_start'
    const isTurnEnd = event?.type === 'turn_end'

    const emit = (ev) => {
      const marked =
        ev && typeof ev === 'object'
          ? { ...ev, _dagChildSession: true, _dagTaskId: taskId }
          : ev
      for (const listener of this.listeners) {
        try {
          listener(marked)
        } catch {}
      }
    }

    if (isTurnStart) {
      if (!this.owner || this.owner === taskId) {
        this.owner = taskId
        emit(event)
      } else {
        this._buffer(event, taskId)
      }
      return
    }

    if (isTurnEnd) {
      if (this.owner === taskId) {
        emit(event)
        this.owner = null
        this._drain()
      } else {
        this._buffer(event, taskId)
      }
      return
    }

    if (!this.owner || this.owner === taskId) {
      emit(event)
    } else {
      this._buffer(event, taskId)
    }
  }

  release(taskId) {
    if (this.owner === taskId) {
      this.owner = null
      this._drain()
    }
    this.buffers.delete(taskId)
  }

  _buffer(event, taskId) {
    if (!this.buffers.has(taskId)) this.buffers.set(taskId, [])
    this.buffers.get(taskId).push(event)
  }

  _drain() {
    while (!this.owner) {
      const nextTaskId = this._pickNextTask()
      if (!nextTaskId) break
      const events = this.buffers.get(nextTaskId) ?? []
      this.buffers.delete(nextTaskId)
      this.owner = nextTaskId
      for (const event of events) {
        const marked =
          event && typeof event === 'object'
            ? { ...event, _dagChildSession: true, _dagTaskId: nextTaskId }
            : event
        for (const listener of this.listeners) {
          try {
            listener(marked)
          } catch {}
        }
        if (event?.type === 'turn_end') {
          this.owner = null
        }
      }
    }
  }

  _pickNextTask() {
    for (const [taskId, events] of this.buffers) {
      if (events.length > 0) return taskId
    }
    return null
  }
}

const turnOutputGates = new WeakMap()

function getTurnOutputGate(mainSession, listeners) {
  if (!turnOutputGates.has(mainSession)) {
    const gate = new TurnOutputGate()
    gate.listeners = listeners
    turnOutputGates.set(mainSession, gate)
  }
  const gate = turnOutputGates.get(mainSession)
  gate.listeners = listeners
  return gate
}

// Task execution helpers

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'))
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('Aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

export const buildTaskPrompt = (taskId, planContent, contextToolkit) => {
  const sections = [`# Execute task ${taskId}`]
  sections.push(
    contextToolkit.milestoneContext
      ? `## Milestone context\n${contextToolkit.milestoneContext}`
      : '## Milestone context\nNo milestone context file available.',
  )
  sections.push(`## Slice goal\n${contextToolkit.sliceGoal}`)
  sections.push(`## Task plan\n${planContent}`)
  if (contextToolkit.dynamicCompletedDeps)
    sections.push(contextToolkit.dynamicCompletedDeps)
  sections.push(
    '## Execution rules (MANDATORY — follow exactly)\n' +
      '- This task runs in parallel with other tasks. Do NOT depend on other running tasks.\n' +
      '- You MUST call `gsd_task_complete` tool after finishing the task.\n' +
      '- You MUST NOT exit without calling `gsd_task_complete`.\n' +
      '- Use subagent at your discretion as needed.\n' +
      '- Do NOT rely on file conflict analysis. Dependencies are explicitly declared in DEPS.json.\n' +
      '- Read/write any files you need. Just finish and call gsd_task_complete.',
  )
  return sections.join('\n\n')
}

export const isTaskCompleteInDb = (taskId, contextToolkit) => {
  try {
    const task = contextToolkit.db?.getTask?.(
      contextToolkit.mid,
      contextToolkit.sid,
      taskId,
    )
    const doneStatuses = new Set(['complete', 'done', 'skipped', 'success'])
    return doneStatuses.has(task?.status?.toLowerCase())
  } catch {
    return false
  }
}

export const createTaskSession = async (taskId, ctx, createAgentSessionFn) => {
  try {
    const sessionId = ctx?.sessionManager?.getSessionId?.()
    ctx?.ui?.notify?.(`[${taskId}] sessionId=${sessionId}`, 'info')

    const mainSession = sessionId
      ? mainSessionsBySessionId.get(sessionId)
      : null
    ctx?.ui?.notify?.(
      `[${taskId}] registry ${mainSession ? 'hit' : 'miss'} for session`,
      mainSession ? 'success' : 'error',
    )

    if (!mainSession) {
      throw new Error(`Main session ${sessionId ?? 'unknown'} not registered`)
    }

    const options = { cwd: ctx?.cwd ?? process.cwd() }

    if (mainSession.resourceLoader) {
      options.resourceLoader = mainSession.resourceLoader
    }
    if (mainSession.modelRegistry) {
      options.modelRegistry = mainSession.modelRegistry
    }
    if (mainSession.settingsManager) {
      options.settingsManager = mainSession.settingsManager
    }
    if (mainSession.model) {
      options.model = mainSession.model
    }
    if (mainSession.thinkingLevel) {
      options.thinkingLevel = mainSession.thinkingLevel
    }
    if (mainSession.getActiveToolNames) {
      const activeToolNames = mainSession.getActiveToolNames()
      if (activeToolNames?.length > 0) {
        options.extraActiveToolNames = activeToolNames
      }
    }
    if (mainSession._customTools?.length > 0) {
      options.customTools = mainSession._customTools
    }
    if (mainSession._scopedModels?.length > 0) {
      options.scopedModels = mainSession._scopedModels
    }
    if (Array.isArray(ctx?.tools) && ctx.tools.length > 0) {
      options.tools = ctx.tools
    }

    const result = await createAgentSessionFn(options)
    if (!result?.session)
      throw new Error('session factory returned no session instance')

    const session = result.session
    session.isSubSession = true

    try {
      const mainExts = mainSession.resourceLoader?.getExtensions?.()
      const childExts = session.resourceLoader?.getExtensions?.()
      const mainExtCount = mainExts?.extensions?.length ?? 0
      const childExtCount = childExts?.extensions?.length ?? 0
      if (childExtCount < mainExtCount) {
        ctx?.ui?.notify?.(
          `[${taskId}] WARNING: child session loaded ${childExtCount} extensions vs main ${mainExtCount}. ` +
            `Guardian and other extensions may be missing. Ensure resourceLoader is inherited correctly.`,
          'warning',
        )
      }
    } catch {}
    const listeners = mainSession._eventListeners
    if (!Array.isArray(listeners)) {
      throw new Error(`main session ${sessionId} has no event listeners`)
    }

    const gate = getTurnOutputGate(mainSession, listeners)

    const unsubscribe = session.subscribe((event) => {
      gate.handleEvent(event, taskId)
    })

    const cleanup = () => {
      try {
        unsubscribe?.()
      } catch {}
      gate.release(taskId)
    }

    ctx?.ui?.notify?.(
      `[${taskId}] bridged to ${listeners.length} listeners`,
      'success',
    )
    return { session, cleanup }
  } catch (err) {
    throw new Error(
      `Failed to create agent session for ${taskId}: ${err.message}`,
    )
  }
}

export const setupSessionAbort = (session, taskAbort, record) => {
  if (!taskAbort.signal) return
  const unsubAbort = () => {
    if (taskAbort.signal.aborted) session.abort?.()
  }
  if (taskAbort.signal.aborted) {
    unsubAbort()
  } else {
    taskAbort.signal.addEventListener('abort', unsubAbort, { once: true })
    record.unsubscribes.push(() =>
      taskAbort.signal.removeEventListener('abort', unsubAbort),
    )
  }
}

const MAX_EMPTY_TURNS = 30

export const runTaskLoop = async (
  session,
  taskId,
  basePrompt,
  contextToolkit,
  abortSignal,
  taskAbort,
  record,
  ctx,
) => {
  let emptyTurnCount = 0
  let totalEmptyTurnCount = 0
  let consecutiveErrors = 0

  // 维护 nextPrompt 状态，只有当确实需要发起新请求时才赋值
  let nextPrompt = basePrompt

  while (true) {
    if (abortSignal?.aborted || taskAbort.signal.aborted) {
      record.status = 'aborted'
      throw new Error('Task aborted')
    }

    if (totalEmptyTurnCount >= MAX_EMPTY_TURNS) {
      record.status = 'failed'
      throw new Error(
        `Task ${taskId} exited ${MAX_EMPTY_TURNS} times without calling gsd_task_complete. Aborting.`,
      )
    }

    try {
      if (nextPrompt) {
        await session.prompt(nextPrompt)
        nextPrompt = null // 消费掉
      }

      // Decoupled synchronization: 让出事件循环，等待任何排队的扩展事件
      try {
        if (session._agentEventQueue) await session._agentEventQueue
      } catch (e) {}

      // 如果 Guardian 发起了修复请求，isStreaming 会变为 true。等待其完成。
      while (session.isStreaming || session.agent?.isStreaming) {
        await new Promise((r) => setTimeout(r, 200))
        try {
          if (session._agentEventQueue) await session._agentEventQueue
        } catch (e) {}
      }

      if (isTaskCompleteInDb(taskId, contextToolkit)) {
        record.status = 'completed'
        return
      }

      // Check if the underlying agent stopped with an error.
      // The session.isRecovering flag is a general contract: any extension
      // (e.g. Guardian) may claim recovery by setting session.isRecovering = true.
      // If no extension claims it, fail immediately — zero waste.
      const lastMsg = session.state?.messages?.at(-1)
      if (lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error') {
        if (!session.isRecovering) {
          // No extension claimed this error. Fail instantly.
          record.status = 'failed'
          throw new Error(
            `Task ${taskId} failed unrecoverably: ${lastMsg.errorMessage || 'unknown error'}`,
          )
        }

        // An extension claimed recovery. Wait for it to release the claim.
        while (session.isRecovering) {
          if (abortSignal?.aborted || taskAbort.signal.aborted)
            throw new Error('Task aborted')
          await new Promise((r) => setTimeout(r, 100))
        }

        // Recovery claim released. Check if the extension started a new stream.
        let streamWait = 0
        while (
          !session.isStreaming &&
          !session.agent?.isStreaming &&
          streamWait < 5000
        ) {
          if (abortSignal?.aborted || taskAbort.signal.aborted)
            throw new Error('Task aborted')
          await new Promise((r) => setTimeout(r, 100))
          streamWait += 100
        }

        if (session.isStreaming || session.agent?.isStreaming) {
          // Extension successfully restarted the agent. Let the main loop handle it.
          continue
        }

        // Extension released but no stream started (budget exhausted).
        record.status = 'failed'
        throw new Error(
          `Task ${taskId} failed after recovery attempts exhausted: ${lastMsg.errorMessage || 'unknown error'}`,
        )
      }

      // 既没报错也没做完，说明是 LLM 的"空回复（忘调工具）"
      consecutiveErrors = 0
      totalEmptyTurnCount++
      if (++emptyTurnCount >= 10) {
        nextPrompt =
          basePrompt +
          `\n\n**SYSTEM NOTICE**: You have exited 10 times without completing the task. Please review the task plan and call gsd_task_complete when done.`
        emptyTurnCount = 0
      } else {
        nextPrompt =
          'You exited without calling `gsd_task_complete`. You MUST finish the task and then call gsd_task_complete.'
      }
    } catch (err) {
      if (abortSignal?.aborted || taskAbort.signal.aborted) {
        record.status = 'aborted'
        throw new Error('Task aborted')
      }

      consecutiveErrors++
      if (consecutiveErrors >= 10) {
        record.status = 'failed'
        throw new Error(
          `Task ${taskId} encountered fatal error: ${err.message}`,
        )
      }

      // 深度防御：如果并非逻辑错误，而是 JS 运行时原生抛出了异常（断网等极端情况），进行本地退避重试
      const delayMs = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), 30000)
      ctx?.ui?.notify?.(
        `[${taskId}] Task agent exception, retrying in ${delayMs}ms (attempt ${consecutiveErrors})`,
        'warning',
      )
      await new Promise((r) => setTimeout(r, delayMs))

      // 异常情况需要重新塞回之前的 Prompt 继续执行
      if (!nextPrompt) nextPrompt = 'Please continue and complete the task.'
    }
  }
}
