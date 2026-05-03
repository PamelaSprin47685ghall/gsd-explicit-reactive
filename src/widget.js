/**
 * dag-status widget — shows DAG execution state in the GSD dashboard.
 * Does NOT override the official gsd-progress widget.
 * Only renders when DAG is active.
 */
export function createDagStatusWidget(ctx) {
  let active = false;
  let tasks = [];       // { id, title, status, tool, elapsed }
  let interval = null;
  let dirty = false;
  let rendering = false;

  return {
    key: "dag-status",

    start(dagState) {
      active = true;
      tasks = dagState.tasks ?? [];
      dirty = true;
      render();
      if (!interval) {
        interval = setInterval(() => { if (dirty) render(); }, 2000);
      }
    },

    update(dagState) {
      tasks = dagState.tasks ?? [];
      dirty = true;
      if (active && !rendering) render();
    },

    stop() {
      active = false;
      tasks = [];
      dirty = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      try { ctx.ui?.setWidget?.("dag-status", undefined); } catch {}
    },

    isActive() {
      return active;
    },
  };

  function render() {
    if (!active || rendering) return;
    rendering = true;
    dirty = false;

    const done = tasks.filter(t => t.status === "done").length;
    const running = tasks.filter(t => t.status === "running").length;
    const ready = tasks.filter(t => t.status === "ready").length;
    const total = tasks.length;

    const lines = [`DAG: active — ${done}/${total} done, ${running} running, ${ready} ready`];

    for (const t of tasks) {
      const icon = t.status === "done"    ? "✓" :
                   t.status === "running" ? "▶" :
                   t.status === "ready"   ? "○" :
                   t.status === "failed"  ? "✗" : "·";
      const tool = t.tool ? ` (${t.tool})` : "";
      const elapsedMs = t.endedAt ? (t.endedAt - t.startedAt) :
                        (t.startedAt ? Date.now() - t.startedAt : (t.elapsed ?? 0));
      const elapsed = elapsedMs > 0 ? ` [${formatElapsed(elapsedMs)}]` : "";
      const deps = t.waitingOn?.length > 0 ? ` waiting [${t.waitingOn.join(",")}]` : "";
      lines.push(`  ${icon} ${t.id}${tool}${elapsed}${deps}`);
    }

    try {
      ctx.ui?.setWidget?.("dag-status", lines, { placement: "aboveEditor" });
    } catch (err) {
      // Log error for debugging
      console.error("[dag-widget] setWidget failed:", err);
    }

    rendering = false;
  }
}

function formatElapsed(ms) {
  if (ms < 2000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}
