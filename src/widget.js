/**
 * dag-status widget — shows DAG execution state in the GSD dashboard.
 * Does NOT override the official gsd-progress widget.
 * Only renders when DAG is active.
 */
export function createDagStatusWidget(pi) {
  let active = false;
  let tasks = [];       // { id, title, status, tool, elapsed }
  let interval = null;

  return {
    key: "dag-status",

    start(dagState) {
      active = true;
      tasks = dagState.tasks ?? [];
      render();
      if (!interval) {
        interval = setInterval(render, 2000);
      }
    },

    update(dagState) {
      tasks = dagState.tasks ?? [];
      if (active) render();
    },

    stop() {
      active = false;
      tasks = [];
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      // Clear the widget area
      pi.ui?.updateWidget?.("dag-status", { active: false, rendered: "" });
    },

    isActive() {
      return active;
    },
  };

  function render() {
    if (!active) return;

    const done = tasks.filter(t => t.status === "done").length;
    const running = tasks.filter(t => t.status === "running").length;
    const ready = tasks.filter(t => t.status === "ready").length;
    const total = tasks.length;

    let body = `DAG: active — ${done}/${total} done, ${running} running, ${ready} ready\n`;

    for (const t of tasks) {
      const icon = t.status === "done"    ? "✓" :
                   t.status === "running" ? "▶" :
                   t.status === "ready"   ? "○" : "·";
      const tool = t.tool ? ` (${t.tool})` : "";
      const elapsed = t.elapsed ? ` [${formatElapsed(t.elapsed)}]` : "";
      const deps = t.waitingOn?.length > 0 ? ` waiting [${t.waitingOn.join(",")}]` : "";
      body += `  ${icon} ${t.id}${tool}${elapsed}${deps}\n`;
    }

    pi.ui?.updateWidget?.("dag-status", {
      active: true,
      rendered: body,
    });
  }
}

function formatElapsed(ms) {
  if (ms < 2000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}
