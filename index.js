import { ensureBundledExtensionPath } from './src/self-injection.js'
import {
  injectExplicitDagEngine,
  registerWaitTool,
  width1Warned,
  setPatchedCreateAgentSession,
} from './src/engine.js'
import { createDagStatusWidget } from './src/widget.js'
import { loadGsdCore } from './src/discovery.js'
import {
  mainSessionsBySessionId,
  rememberSession,
} from './src/session-registry.js'

// Lazy-load to avoid blocking module initialization
let AgentSession = null
let createAgentSession = null
let importPromise = null

async function ensureCodingAgent() {
  if (!importPromise) {
    importPromise = import('@gsd/pi-coding-agent').catch((err) => {
      console.error('[DAG] Failed to load @gsd/pi-coding-agent:', err)
      return { AgentSession: null, createAgentSession: null }
    })
  }
  const mod = await importPromise
  if (mod.AgentSession) AgentSession = mod.AgentSession
  if (mod.createAgentSession) createAgentSession = mod.createAgentSession
  return mod
}

ensureBundledExtensionPath(import.meta.url)

const registeredPluginApis = new WeakSet()

const patchAgentSessionPrototype = () => {
  if (!AgentSession?.prototype) return

  const patchKey = Symbol.for(
    'gsd-explicit-reactive.agent-session-prototype-patched',
  )
  if (globalThis[patchKey]) return
  globalThis[patchKey] = true

  const originalBindExtensions = AgentSession.prototype.bindExtensions
  AgentSession.prototype.bindExtensions = async function (...args) {
    rememberSession(this)
    const result = await originalBindExtensions.apply(this, args)
    rememberSession(this)
    return result
  }

  const originalNewSession = AgentSession.prototype.newSession
  AgentSession.prototype.newSession = async function (...args) {
    rememberSession(this)
    const result = await originalNewSession.apply(this, args)
    if (result) rememberSession(this)
    return result
  }
}

async function setupPatches() {
  await ensureCodingAgent()

  if (createAgentSession) {
    const originalCreateAgentSession = createAgentSession
    const patchedCreateAgentSession = async (options) => {
      if (!originalCreateAgentSession) {
        throw new Error('@gsd/pi-coding-agent createAgentSession unavailable')
      }
      const result = await originalCreateAgentSession(options)
      rememberSession(result?.session)
      return result
    }
    setPatchedCreateAgentSession(patchedCreateAgentSession)
  }

  patchAgentSessionPrototype()
}

export default async function explicitReactivePlugin(pi) {
  if (registeredPluginApis.has(pi)) return
  registeredPluginApis.add(pi)

  // Ensure patches are applied before any DAG operations
  await setupPatches()

  const dagWidgets = new Map()
  const dagTaskManagers = new Map()

  const injectEngineSafely = async (ctx) => {
    try {
      const core = await loadGsdCore()
      if (!core) {
        ctx?.ui?.notify?.(
          '[DAG] GSD core modules not found. Plugin disabled.',
          'warning',
        )
        return
      }
      ctx?.ui?.notify?.(
        '[DAG] GSD core modules loaded, injecting dispatch rule...',
        'info',
      )
      injectExplicitDagEngine(core, pi, ctx, dagWidgets, dagTaskManagers)
    } catch (err) {
      ctx?.ui?.notify?.(`[DAG] Initialization failed: ${err.message}`, 'error')
    }
  }

  registerWaitTool(pi, dagTaskManagers)

  await injectEngineSafely(undefined)

  pi.on('session_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.()
    const hasSession = sessionId
      ? mainSessionsBySessionId.has(sessionId)
      : false
    ctx?.ui?.notify?.(
      `[DAG] Session registry ${hasSession ? 'has' : 'missing'} current session ${sessionId ?? 'unknown'}`,
      hasSession ? 'success' : 'warning',
    )

    if (sessionId) {
      if (!dagWidgets.has(sessionId)) {
        dagWidgets.set(sessionId, createDagStatusWidget(ctx))
      }
    }

    await injectEngineSafely(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.()
    if (sessionId) {
      if (dagTaskManagers.has(sessionId)) {
        const manager = dagTaskManagers.get(sessionId)
        manager.abortAll()
        dagTaskManagers.delete(sessionId)
      }
      if (dagWidgets.has(sessionId)) {
        const widget = dagWidgets.get(sessionId)
        widget.stop?.()
        dagWidgets.delete(sessionId)
      }
    }
    width1Warned.clear()
  })
}
