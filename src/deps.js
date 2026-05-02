import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function loadDepsError(basePath, mid, sid) {
  const path = join(basePath, ".gsd", "milestones", mid, "slices", sid, "DEPS-ERROR.json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

const validateBasicStructure = (deps, errors) => {
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
    errors.push("DEPS must be a plain object");
    return false;
  }
  if (Array.isArray(deps.tasks)) {
    errors.push("deps.tasks must be a plain object, not an array");
    return false;
  }
  if (deps.version !== 1) {
    errors.push(`Unsupported DEPS version: ${deps.version}`);
    // return true intentionally so we can accumulate more errors downstream
  }
  return true;
};

const validateTaskDeclarations = (taskIds, declaredIds, errors) => {
  for (const id of taskIds) {
    if (!declaredIds.has(id)) errors.push(`Missing task in DEPS.tasks: ${id}`);
  }
};

const validateTaskDependencies = (deps, taskIds, declaredIds, errors) => {
  for (const [id, spec] of Object.entries(deps.tasks ?? {})) {
    if (!taskIds.has(id)) {
      errors.push(`Unknown task declared in DEPS: ${id}`);
      continue;
    }
    if (!spec || !Array.isArray(spec.depends_on)) {
      errors.push(`Task ${id}: depends_on must be an array`);
      continue;
    }
    const seenDeps = new Set();
    for (const dep of spec.depends_on) {
      if (typeof dep !== "string") {
        errors.push(`Task ${id}: depends_on must contain only strings, got ${typeof dep}`);
        continue;
      }
      if (seenDeps.has(dep)) {
        errors.push(`Task ${id}: duplicate dependency ${dep}`);
        continue;
      }
      seenDeps.add(dep);
      if (!declaredIds.has(dep)) errors.push(`Task ${id} depends on unknown task: ${dep}`);
      if (dep === id) errors.push(`Task ${id}: self-dependency`);
    }
  }
};

export function validateExplicitDeps(deps, sliceTasks) {
  const errors = [];
  if (!validateBasicStructure(deps, errors)) return { ok: false, errors };

  const taskIds = new Set(sliceTasks.map(t => t.id));
  const declaredIds = new Set(Object.keys(deps.tasks ?? {}));

  validateTaskDeclarations(taskIds, declaredIds, errors);
  validateTaskDependencies(deps, taskIds, declaredIds, errors);

  const cycle = findCycle(deps.tasks ?? {});
  if (cycle.length > 0) errors.push(`Cycle detected in DEPS: ${cycle.join(" → ")}`);

  return { ok: errors.length === 0, errors };
}

function findCycle(tasks) {
  const visited = {};
  const path = [];

  function dfs(id) {
    if (visited[id] === "done") return null;
    if (visited[id] === "visiting") {
      const cycleStart = path.indexOf(id);
      return path.slice(cycleStart).concat(id);
    }
    visited[id] = "visiting";
    path.push(id);
    for (const dep of tasks[id]?.depends_on ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    path.pop();
    visited[id] = "done";
    return null;
  }

  for (const id of Object.keys(tasks)) {
    if (!visited[id]) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function computeReadySet(deps, allTasks, completedIds) {
  // Use completedIds (in-memory state) instead of allTasks[].status (DB state)
  // to avoid race conditions and DB sync delays
  return Object.entries(deps.tasks ?? {})
    .filter(([id, spec]) => {
      if (completedIds && completedIds.has(id)) return false;
      return spec.depends_on.every(d => completedIds ? completedIds.has(d) : false);
    })
    .map(([id]) => id);
}

export function calculateDagMetrics(deps) {
  const taskIds = Object.keys(deps.tasks ?? {});
  const N = taskIds.length;
  if (N === 0) return { totalTasks: 0, criticalPathLength: 0, averageWidth: 0 };

  const memo = {};
  const visiting = new Set();
  
  function getDepth(id) {
    if (memo[id] !== undefined) return memo[id];
    if (visiting.has(id)) return 0;
    
    visiting.add(id);
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
    visiting.delete(id);
    return memo[id];
  }

  const L = Math.max(...taskIds.map(getDepth));
  return { totalTasks: N, criticalPathLength: L, averageWidth: N / L };
}

export function persistLatestError(basePath, mid, sid, errors, invalidDeps, ctx) {
  const errorPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, "DEPS-ERROR.json");
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

export function clearLatestError(basePath, mid, sid, ctx) {
  const errorPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, "DEPS-ERROR.json");
  try {
    if (existsSync(errorPath)) unlinkSync(errorPath);
  } catch (err) {
    ctx?.ui?.notify?.(`[DAG] Failed to delete DEPS-ERROR.json: ${err.message}`, "error");
  }
}

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
