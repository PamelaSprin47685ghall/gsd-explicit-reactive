import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Load DEPS-ERROR.json for a slice, returning null when absent.
 */
export function loadDepsError(basePath, mid, sid) {
  const path = join(basePath, ".gsd", "milestones", mid, "slices", sid, "DEPS-ERROR.json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

/**
 * Validate DEPS.json structure and semantics.
 * Returns { ok, errors[] }
 */
export function validateExplicitDeps(deps, sliceTasks) {
  const errors = [];

  if (Array.isArray(deps.tasks)) {
    errors.push("deps.tasks must be a plain object, not an array");
    return { ok: false, errors };
  }

  const taskIds = new Set(sliceTasks.map(t => t.id));
  const declaredIds = new Set(Object.keys(deps.tasks ?? {}));

  if (deps.version !== 1) {
    errors.push(`Unsupported DEPS version: ${deps.version}`);
  }

  // Every slice task must be declared
  for (const id of taskIds) {
    if (!declaredIds.has(id)) {
      errors.push(`Missing task in DEPS.tasks: ${id}`);
    }
  }

  // Every declared task must be valid
  for (const [id, spec] of Object.entries(deps.tasks ?? {})) {
    if (!taskIds.has(id)) {
      errors.push(`Unknown task declared in DEPS: ${id}`);
      continue;
    }
    if (!spec || !Array.isArray(spec.depends_on)) {
      errors.push(`Task ${id}: depends_on must be an array`);
      continue;
    }
    for (const dep of spec.depends_on) {
      if (!declaredIds.has(dep)) {
        errors.push(`Task ${id} depends on unknown task: ${dep}`);
      }
      if (dep === id) {
        errors.push(`Task ${id}: self-dependency`);
      }
    }
  }

  // Cycle detection (DFS)
  const cycle = findCycle(deps.tasks ?? {});
  if (cycle.length > 0) {
    errors.push(`Cycle detected in DEPS: ${cycle.join(" → ")}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * DFS cycle detection using path.indexOf for exact cycle extraction.
 * Returns the precise cycle path (e.g. ["T02","T03","T04","T02"]) if found, else [].
 */
function findCycle(tasks) {
  const visited = {};      // 'visiting' | 'done'
  const path = [];

  function dfs(id) {
    if (visited[id] === "done") return null;
    if (visited[id] === "visiting") {
      const cycleStartIdx = path.indexOf(id);
      if (cycleStartIdx === -1) return null;
      return [...path.slice(cycleStartIdx), id];
    }
    visited[id] = "visiting";
    path.push(id);
    for (const dep of tasks[id]?.depends_on ?? []) {
      const result = dfs(dep);
      if (result) return result;
    }
    visited[id] = "done";
    path.pop();
    return null;
  }

  for (const id of Object.keys(tasks)) {
    const result = dfs(id);
    if (result) return result;
  }
  return [];
}

/**
 * Compute the set of ready-to-execute tasks given DEPS and current statuses.
 * A task is ready when all its dependencies are in a done status.
 */
export function computeReadySet(deps, allTasks) {
  const statuses = new Map(allTasks.map(t => [t.id, t.status]));
  const doneStatuses = new Set(["complete", "done", "skipped", "success"]);

  return Object.entries(deps.tasks ?? {})
    .filter(([id, spec]) => {
      const s = (statuses.get(id) ?? "pending").toLowerCase();
      if (doneStatuses.has(s)) return false;
      return spec.depends_on.every(d => {
        const ds = (statuses.get(d) ?? "pending").toLowerCase();
        return doneStatuses.has(ds);
      });
    })
    .map(([id]) => id);
}

/**
 * Calculate average concurrency width of a DAG.
 * W_avg = N / L where N = total tasks, L = critical path length.
 * A value close to 1 indicates a nearly serial chain.
 */
export function calculateDagMetrics(deps) {
  const taskIds = Object.keys(deps.tasks ?? {});
  const N = taskIds.length;
  if (N === 0) return { totalTasks: 0, criticalPathLength: 0, averageWidth: 0 };

  const memo = {};
  function getDepth(id) {
    if (memo[id]) return memo[id];
    const depsList = deps.tasks[id]?.depends_on ?? [];
    if (depsList.length === 0) {
      memo[id] = 1;
    } else {
      let maxDep = 0;
      for (const depId of depsList) {
        maxDep = Math.max(maxDep, getDepth(depId));
      }
      memo[id] = maxDep + 1;
    }
    return memo[id];
  }

  let L = 0;
  for (const id of taskIds) {
    L = Math.max(L, getDepth(id));
  }

  return { totalTasks: N, criticalPathLength: L, averageWidth: N / L };
}

/**
 * Persist the latest DEPS validation error to DEPS-ERROR.json.
 */
export function persistLatestError(basePath, mid, sid, errors, invalidDeps, ctx) {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  const errorPath = join(dir, "DEPS-ERROR.json");
  const payload = {
    errors: Array.isArray(errors) ? errors : [errors],
    invalidDeps,
    attemptedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(errorPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    ctx?.ui?.notify?.(`[DAG] Failed to write DEPS-ERROR.json: ${err.message}`, "error");
  }
}

/**
 * Clear DEPS-ERROR.json after successful validation.
 */
export function clearLatestError(basePath, mid, sid, ctx) {
  const errorPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, "DEPS-ERROR.json");
  try {
    if (existsSync(errorPath)) unlinkSync(errorPath);
  } catch (err) {
    ctx?.ui?.notify?.(`[DAG] Failed to delete DEPS-ERROR.json: ${err.message}`, "error");
  }
}

/**
 * Load DEPS.json, parse it, and validate.
 * Returns { deps, error, errors } where error is a joined string, errors is the raw array.
 */
export function loadAndValidateDeps(basePath, mid, sid, sliceTasks) {
  const depsPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, "DEPS.json");
  if (!existsSync(depsPath)) {
    return { deps: null, error: `Missing DEPS.json: ${depsPath}`, errors: [`Missing DEPS.json: ${depsPath}`] };
  }

  let raw;
  try {
    raw = readFileSync(depsPath, "utf-8");
  } catch (e) {
    return { deps: null, error: `Cannot read DEPS.json: ${e.message}`, errors: [`Cannot read DEPS.json: ${e.message}`] };
  }

  let deps;
  try {
    deps = JSON.parse(raw);
  } catch (e) {
    return { deps: null, error: `DEPS.json invalid JSON: ${e.message}`, errors: [`DEPS.json invalid JSON: ${e.message}`] };
  }

  const { ok, errors } = validateExplicitDeps(deps, sliceTasks);
  if (!ok) {
    return { deps, error: errors.join("; "), errors };
  }

  return { deps, error: null, errors: null };
}

/**
 * Build a hash of task titles keyed by ID for quick lookup.
 */
export function buildTaskTitleMap(tasks) {
  return Object.fromEntries(tasks.map(t => [t.id, t.title]));
}
