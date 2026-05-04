/**
 * dag-status widget — shows DAG execution state in the GSD status bar.
 * Does NOT override the official gsd-progress widget.
 * Only renders when DAG is active.
 */
export function createDagStatusWidget(ctx) {
  let active = false
  let tasks = [] // { id, title, status, tool, elapsed }
  let interval = null
  let dirty = false

  return {
    key: 'dag-status',

    start(dagState) {
      active = true
      tasks = dagState.tasks ?? []
      dirty = true
      render()
      if (!interval) {
        interval = setInterval(() => {
          if (dirty) render()
        }, 2000)
      }
    },

    update(dagState) {
      tasks = dagState.tasks ?? []
      dirty = true
      if (active) render()
    },

    stop() {
      active = false
      tasks = []
      dirty = false
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    },

    isActive() {
      return active
    },
  }

  function render() {
    if (!active || !dirty) return
    dirty = false

    const done = tasks.filter((t) => t.status === 'done').length
    const running = tasks.filter((t) => t.status === 'running').length
    const ready = tasks.filter((t) => t.status === 'ready').length
    const total = tasks.length

    const runningNames = tasks
      .filter((t) => t.status === 'running')
      .map((t) => t.id)
      .join(',')

    const text =
      running > 0
        ? `DAG ▶ ${running}/${total} ${runningNames}`
        : `DAG ○ ${done}/${total}`

    try {
      ctx?.ui?.statusBar?.(text)
    } catch {
      // statusBar not available — silently degrade
    }
  }
}
