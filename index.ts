import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_NAME = "gsd-explicit-reactive";
const FORCED_MAX_PARALLEL = 8;
const TASK_ID_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const REQUIRED_MODULES = [
  "auto-dispatch",
  "files",
  "gsd-db",
  "auto-prompts",
  "reactive-graph",
  "preferences-models",
] as const;

type RequiredModuleName = (typeof REQUIRED_MODULES)[number];
type LoadedModules = Record<RequiredModuleName, any>;

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeDetail(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim();
  } catch {
    return "[unserializable]";
  }
}

function logDispatchDiagnostic(
  phase: string,
  cause: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  const detailPairs = Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${normalizeDetail(v)}`);
  const suffix = detailPairs.length > 0 ? ` ${detailPairs.join(" ")}` : "";
  process.stderr.write(
    `[dispatch-diagnostic plugin=${PLUGIN_NAME} phase=${phase} cause=${cause}] ${message}${suffix}\n`,
  );
}

function compareTaskIds(a: string, b: string): number {
  const primary = TASK_ID_COLLATOR.compare(a, b);
  if (primary !== 0) return primary;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function uniqueSortedTaskIds(taskIds: string[]): string[] {
  return [...new Set(taskIds)].sort(compareTaskIds);
}

function isClosedTaskStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "complete" || normalized === "done" || normalized === "skipped";
}

function taskIdFromPlanFile(fileName: string): string | null {
  if (!fileName.endsWith("-PLAN.md")) return null;
  const taskId = fileName.slice(0, -"-PLAN.md".length).trim();
  if (!taskId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return null;
  return taskId;
}

function sortTaskPlanFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const aId = taskIdFromPlanFile(a) ?? a;
    const bId = taskIdFromPlanFile(b) ?? b;
    return compareTaskIds(aId, bId);
  });
}

function parseWaveMeta(rawWave: unknown): { wave: number | null; reason: string | null } {
  if (rawWave === undefined || rawWave === null) {
    return { wave: null, reason: "wave-missing" };
  }

  const normalized = typeof rawWave === "string" ? rawWave.trim() : rawWave;
  if (normalized === "") {
    return { wave: null, reason: "wave-empty" };
  }

  const numericWave = Number(normalized);
  if (!Number.isFinite(numericWave)) {
    return { wave: null, reason: "wave-non-finite" };
  }
  if (!Number.isInteger(numericWave)) {
    return { wave: null, reason: "wave-non-integer" };
  }
  if (numericWave < 1) {
    return { wave: null, reason: "wave-out-of-range" };
  }

  return { wave: numericWave, reason: null };
}

function clearReactiveStateSafely(
  reactiveGraph: any,
  basePath: string,
  mid: string,
  sid: string,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  if (typeof reactiveGraph?.clearReactiveState !== "function") {
    logDispatchDiagnostic("reactive-dispatch", "state-clear-unavailable", "Reactive state clear hook is unavailable", {
      mid,
      sid,
      reason,
    });
    return;
  }

  try {
    reactiveGraph.clearReactiveState(basePath, mid, sid);
    logDispatchDiagnostic("reactive-dispatch", "state-cleared", "Cleared reactive state for deterministic fallback", {
      mid,
      sid,
      reason,
      ...details,
    });
  } catch (err) {
    logDispatchDiagnostic("reactive-dispatch", "state-clear-failed", "Failed to clear reactive state during fallback", {
      mid,
      sid,
      reason,
      error: errMessage(err),
      ...details,
    });
  }
}

function moduleExists(dir: string, name: string): boolean {
  return existsSync(join(dir, `${name}.js`)) || existsSync(join(dir, `${name}.ts`));
}

function resolveModulePath(dir: string, name: string): string {
  const jsPath = join(dir, `${name}.js`);
  if (existsSync(jsPath)) return jsPath;

  const tsPath = join(dir, `${name}.ts`);
  if (existsSync(tsPath)) return tsPath;

  throw new Error(`module '${name}' not found under ${dir}`);
}

function buildCoreCandidates(): string[] {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const raw = [
    process.env.GSD_CODING_AGENT_DIR ? join(process.env.GSD_CODING_AGENT_DIR, "extensions", "gsd") : null,
    process.env.GSD_CODING_AGENT_DIR ? process.env.GSD_CODING_AGENT_DIR : null,
    process.env.GSD_PKG_ROOT ? join(process.env.GSD_PKG_ROOT, "dist", "resources", "extensions", "gsd") : null,
    process.env.GSD_PKG_ROOT ? join(process.env.GSD_PKG_ROOT, "src", "resources", "extensions", "gsd") : null,
    join(extensionDir, "..", "gsd"),
    join(extensionDir, "..", "gsd-2", "dist", "resources", "extensions", "gsd"),
    join(extensionDir, "..", "gsd-2", "src", "resources", "extensions", "gsd"),
    join(process.cwd(), "gsd", "dist", "resources", "extensions", "gsd"),
    join(process.cwd(), "gsd", "src", "resources", "extensions", "gsd"),
    join(process.cwd(), "gsd-2", "dist", "resources", "extensions", "gsd"),
    join(process.cwd(), "gsd-2", "src", "resources", "extensions", "gsd"),
  ].filter(Boolean) as string[];

  return [...new Set(raw.map((p) => resolve(p)))];
}

function selectCorePath(candidates: string[]): {
  corePath: string | null;
  inspected: Array<{ candidate: string; missing: string[] }>;
} {
  const inspected: Array<{ candidate: string; missing: string[] }> = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      inspected.push({ candidate, missing: ["<directory-missing>"] });
      continue;
    }

    const missing = REQUIRED_MODULES.filter((name) => !moduleExists(candidate, name));
    inspected.push({ candidate, missing: [...missing] });

    if (missing.length === 0) {
      return { corePath: candidate, inspected };
    }
  }

  return { corePath: null, inspected };
}

async function loadCoreModules(corePath: string): Promise<LoadedModules> {
  const loaded = {} as LoadedModules;

  for (const name of REQUIRED_MODULES) {
    const modulePath = resolveModulePath(corePath, name);
    try {
      loaded[name] = await import(pathToFileURL(modulePath).href);
      logDispatchDiagnostic("module-load", "module-loaded", "Loaded internal core module", {
        module: name,
        modulePath,
      });
    } catch (err) {
      throw new Error(`failed to import ${name} from ${modulePath}: ${errMessage(err)}`);
    }
  }

  return loaded;
}

export default async function registerForcedReactiveDispatch(pi: ExtensionAPI) {
  // keep signature for extension loader; `pi` is intentionally unused here
  void pi;

  logDispatchDiagnostic("module-discovery", "start", "Starting forced dispatch initialization", {
    forcedMaxParallel: FORCED_MAX_PARALLEL,
  });

  const candidates = buildCoreCandidates();
  const { corePath: gsdCorePath, inspected } = selectCorePath(candidates);

  if (!gsdCorePath) {
    logDispatchDiagnostic("module-discovery", "core-path-not-found", "Could not locate GSD internal extension directory", {
      searched: inspected.map((row) => `${row.candidate}=>${row.missing.join(",")}`).join(" | "),
    });
    return;
  }

  logDispatchDiagnostic("module-discovery", "core-path-selected", "Using GSD internal extension directory", {
    corePath: gsdCorePath,
  });

  let loadedModules: LoadedModules;
  try {
    loadedModules = await loadCoreModules(gsdCorePath);
  } catch (err) {
    logDispatchDiagnostic("module-load", "core-modules-import-failed", "Failed to load required GSD internal modules", {
      corePath: gsdCorePath,
      error: errMessage(err),
    });
    return;
  }

  const autoDispatch = loadedModules["auto-dispatch"];
  const filesModule = loadedModules["files"];
  const dbModule = loadedModules["gsd-db"];
  const promptsModule = loadedModules["auto-prompts"];
  const reactiveGraph = loadedModules["reactive-graph"];
  const prefsModels = loadedModules["preferences-models"];

  const DISPATCH_RULES = autoDispatch?.DISPATCH_RULES;

  if (!Array.isArray(DISPATCH_RULES)) {
    logDispatchDiagnostic("patch-mount", "dispatch-rules-missing", "auto-dispatch export DISPATCH_RULES is not an array", {
      exportType: typeof DISPATCH_RULES,
    });
    return;
  }

  if (typeof promptsModule?.buildReactiveExecutePrompt !== "function") {
    logDispatchDiagnostic("module-load", "contract-mismatch", "auto-prompts missing buildReactiveExecutePrompt", {
      module: "auto-prompts",
    });
    return;
  }

  if (typeof reactiveGraph?.saveReactiveState !== "function") {
    logDispatchDiagnostic("module-load", "contract-mismatch", "reactive-graph missing saveReactiveState", {
      module: "reactive-graph",
    });
    return;
  }

  if (typeof filesModule?.splitFrontmatter !== "function" || typeof filesModule?.parseFrontmatterMap !== "function") {
    logDispatchDiagnostic("module-load", "contract-mismatch", "files module missing frontmatter helpers", {
      module: "files",
    });
    return;
  }

  const enforceWaveBreakdownRule = {
    name: "executing → enforce-wave-breakdown",
    match: async ({ state, mid, basePath }: any) => {
      if (state.phase !== "executing" || !state.activeSlice) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");

      let files: string[] = [];
      try {
        files = sortTaskPlanFiles(readdirSync(tasksDir).filter((f) => f.endsWith("-PLAN.md")));
      } catch (err) {
        logDispatchDiagnostic("wave-rewrite", "tasks-dir-read-failed", "Unable to scan task plans for wave rewrite gate", {
          mid,
          sid,
          tasksDir,
          error: errMessage(err),
        });
        return null;
      }

      let needsOptimization = false;
      for (const file of files) {
        const tid = taskIdFromPlanFile(file) ?? file.replace("-PLAN.md", "");
        const taskPath = join(tasksDir, file);
        let content = "";
        try {
          content = readFileSync(taskPath, "utf-8");
        } catch (err) {
          logDispatchDiagnostic("wave-rewrite", "task-plan-read-failed", "Failed reading task plan while checking wave annotations", {
            mid,
            sid,
            tid,
            taskPath,
            error: errMessage(err),
          });
          return null;
        }

        let meta: Record<string, unknown> = {};
        try {
          const [fm] = filesModule.splitFrontmatter(content);
          meta = fm ? filesModule.parseFrontmatterMap(fm) : {};
        } catch (err) {
          logDispatchDiagnostic("wave-rewrite", "frontmatter-parse-failed", "Failed to parse task frontmatter while checking wave annotations", {
            mid,
            sid,
            tid,
            taskPath,
            error: errMessage(err),
          });
          needsOptimization = true;
          break;
        }

        const waveMeta = parseWaveMeta(meta.wave);
        if (waveMeta.wave === null) {
          logDispatchDiagnostic("wave-rewrite", waveMeta.reason ?? "wave-invalid", "Detected task without valid wave metadata; forcing rewrite", {
            mid,
            sid,
            tid,
            taskPath,
            rawWave: meta.wave,
          });
          needsOptimization = true;
          break;
        }
      }

      if (!needsOptimization) return null;

      const unitId = `${mid}/${sid}/optimize-waves`;
      logDispatchDiagnostic("wave-rewrite", "dispatch", "Dispatching forced wave rewrite step", {
        mid,
        sid,
        unitId,
        taskPlanCount: files.length,
      });

      return {
        action: "dispatch",
        unitType: "custom-step",
        unitId,
        prompt: `## Wave-Based Execution Optimization (CRITICAL)

You are about to execute slice \`${sid}: ${sTitle}\`. However, the current task plan is not optimized for our execution engine.

**ENGINE CONSTRAINTS (Bulk Synchronous Parallel):**
Our engine executes tasks in synchronous "waves". It dispatches a batch of tasks simultaneously and **waits for ALL of them to finish** before moving to the next wave.
If you put one massive task and two tiny tasks in the same wave, the tiny tasks will finish in seconds, and the engine will sit completely idle waiting for the massive task to finish.

**Your Mission:**
1. **Uniform Task Sizing:** You MUST break down the current coarse tasks in \`${sid}-PLAN.md\` into smaller sub-tasks that are **roughly EQUAL in estimated execution time and complexity**.
2. **Wave Assignment:** Group independent tasks that can be safely executed in parallel into the same wave.
3. **Rewrite Files:** Use the \`write\` or \`edit\` tools to rewrite \`${sid}-PLAN.md\` and the \`tasks/Txx-PLAN.md\` files to reflect this new uniform architecture.
4. **The Proof Marker:** For EVERY \`Txx-PLAN.md\` file, you MUST inject a \`wave: <number>\` field into its YAML frontmatter.
   - Example format for a task in the first batch:
     \`\`\`yaml
     ---
     wave: 1
     ---
     \`\`\`
   - Tasks in \`wave: 2\` will only start after ALL tasks in \`wave: 1\` are completely finished.

Do NOT start executing the actual code/tasks yet. Only redesign the plan into uniform waves, rewrite the markdown files, and complete your turn.`,
      };
    },
  };

  const waveReactiveRule = {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry }: any) => {
      if (state.phase !== "executing" || !state.activeTask || !state.activeSlice) return null;

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const maxParallel = FORCED_MAX_PARALLEL;
      const subagentModel =
        prefs?.reactive_execution?.subagent_model ??
        prefsModels.resolveModelWithFallbacksForUnit("subagent")?.primary;

      const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
      let files: string[] = [];
      try {
        files = sortTaskPlanFiles(readdirSync(tasksDir).filter((f) => f.endsWith("-PLAN.md")));
      } catch (err) {
        logDispatchDiagnostic("reactive-dispatch", "tasks-dir-read-failed", "Unable to read tasks directory for forced reactive dispatch", {
          mid,
          sid,
          tasksDir,
          error: errMessage(err),
        });
        return null;
      }

      const completed = new Set<string>();
      const pendingTasks: Array<{ id: string; wave: number }> = [];
      const invalidWaveMeta: Array<{ id: string; reason: string; rawWave: unknown }> = [];
      const dbAvailable = typeof dbModule?.isDbAvailable === "function" && dbModule.isDbAvailable();

      for (const file of files) {
        const tid = taskIdFromPlanFile(file) ?? file.replace("-PLAN.md", "");

        let done = false;
        if (dbAvailable && typeof dbModule?.getTask === "function") {
          const dbTask = dbModule.getTask(mid, sid, tid);
          if (dbTask && isClosedTaskStatus(dbTask.status)) {
            done = true;
          }
        }

        if (done) {
          completed.add(tid);
          continue;
        }

        const taskPath = join(tasksDir, file);
        let content = "";
        try {
          content = readFileSync(taskPath, "utf-8");
        } catch (err) {
          logDispatchDiagnostic("reactive-dispatch", "task-plan-read-failed", "Failed reading task plan during forced reactive dispatch", {
            mid,
            sid,
            tid,
            taskPath,
            error: errMessage(err),
          });
          return null;
        }

        let meta: Record<string, unknown> = {};
        try {
          const [fm] = filesModule.splitFrontmatter(content);
          meta = fm ? filesModule.parseFrontmatterMap(fm) : {};
        } catch (err) {
          invalidWaveMeta.push({
            id: tid,
            reason: "frontmatter-parse-failed",
            rawWave: errMessage(err),
          });
          continue;
        }

        const waveMeta = parseWaveMeta(meta.wave);
        if (waveMeta.wave === null) {
          invalidWaveMeta.push({
            id: tid,
            reason: waveMeta.reason ?? "wave-invalid",
            rawWave: meta.wave,
          });
          continue;
        }

        pendingTasks.push({ id: tid, wave: waveMeta.wave });
      }

      if (invalidWaveMeta.length > 0) {
        const invalidTasks = [...invalidWaveMeta]
          .sort((a, b) => compareTaskIds(a.id, b.id) || a.reason.localeCompare(b.reason))
          .map((entry) => `${entry.id}:${entry.reason}`)
          .join(" | ");

        logDispatchDiagnostic("reactive-dispatch", "wave-metadata-invalid", "Skipping forced reactive dispatch due to invalid wave metadata", {
          mid,
          sid,
          fallback: "sequential",
          invalidCount: invalidWaveMeta.length,
          invalidTasks,
        });

        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "invalid-wave-metadata", {
          invalidCount: invalidWaveMeta.length,
        });
        return null;
      }

      const completedSorted = uniqueSortedTaskIds([...completed]);
      if (pendingTasks.length === 0) {
        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "no-pending-wave-tasks", {
          completedCount: completedSorted.length,
        });
        return null;
      }

      pendingTasks.sort((a, b) => a.wave - b.wave || compareTaskIds(a.id, b.id));

      const minWave = pendingTasks[0].wave;
      const currentWaveIds = uniqueSortedTaskIds(
        pendingTasks
          .filter((task) => task.wave === minWave)
          .map((task) => task.id),
      );

      if (currentWaveIds.length <= 1) {
        logDispatchDiagnostic("reactive-dispatch", "insufficient-parallel-ready", "Current wave has <=1 runnable task; falling back to sequential execution", {
          mid,
          sid,
          wave: minWave,
          readyTasks: currentWaveIds.length,
        });
        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "single-ready-task", {
          wave: minWave,
          readyTasks: currentWaveIds.length,
        });
        return null;
      }

      const selected = currentWaveIds.slice(0, maxParallel);
      if (selected.length <= 1) {
        logDispatchDiagnostic("reactive-dispatch", "insufficient-dispatch-batch", "Selected batch is too small for forced reactive parallel dispatch", {
          mid,
          sid,
          wave: minWave,
          readyTasks: currentWaveIds.length,
          selectedTasks: selected.length,
          maxParallel,
        });
        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "insufficient-dispatch-batch", {
          wave: minWave,
          selectedTasks: selected.length,
        });
        return null;
      }

      const batchSuffix = selected.join(",");
      if (!batchSuffix) {
        logDispatchDiagnostic("reactive-dispatch", "empty-batch-suffix", "Selected batch resolved to empty unitId suffix", {
          mid,
          sid,
          wave: minWave,
        });
        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "empty-batch-suffix", {
          wave: minWave,
        });
        return null;
      }

      const unitId = `${mid}/${sid}/reactive+${batchSuffix}`;
      const knownTaskIds = uniqueSortedTaskIds([
        ...completedSorted,
        ...pendingTasks.map((task) => task.id),
      ]);

      logDispatchDiagnostic("reactive-dispatch", "batch-selected", "Selected deterministic forced reactive batch", {
        mid,
        sid,
        wave: minWave,
        readyTasks: currentWaveIds.length,
        dispatchedTasks: selected.length,
        truncated: selected.length < currentWaveIds.length,
        maxParallel,
        ordering: "wave-asc/task-id-collator+byte",
        selected: selected.join(","),
        unitId,
      });

      try {
        reactiveGraph.saveReactiveState(basePath, mid, sid, {
          sliceId: sid,
          completed: completedSorted,
          dispatched: selected,
          graphSnapshot: {
            taskCount: knownTaskIds.length,
            edgeCount: 0,
            readySetSize: currentWaveIds.length,
            ambiguous: false,
          },
          updatedAt: new Date().toISOString(),
        });

        logDispatchDiagnostic("reactive-dispatch", "state-written", "Persisted forced reactive dispatch state", {
          mid,
          sid,
          wave: minWave,
          completedCount: completedSorted.length,
          dispatchedTasks: selected.length,
          readySetSize: currentWaveIds.length,
          taskCount: knownTaskIds.length,
          unitId,
        });
      } catch (err) {
        logDispatchDiagnostic("reactive-dispatch", "state-write-failed", "Failed to persist reactive dispatch state", {
          mid,
          sid,
          wave: minWave,
          unitId,
          error: errMessage(err),
        });
        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "state-write-failed", {
          wave: minWave,
          unitId,
        });
        return null;
      }

      logDispatchDiagnostic("reactive-dispatch", "dispatch", "Dispatching forced reactive-execute batch", {
        mid,
        sid,
        wave: minWave,
        readyTasks: currentWaveIds.length,
        dispatchedTasks: selected.length,
        maxParallel,
        unitId,
      });

      return {
        action: "dispatch",
        unitType: "reactive-execute",
        unitId,
        prompt: await promptsModule.buildReactiveExecutePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          selected,
          basePath,
          subagentModel,
          { sessionContextWindow, modelRegistry },
        ),
      };
    },
  };

  const targetRuleName = "executing → reactive-execute (parallel dispatch)";
  const isReactiveDispatchRule = (rule: any) =>
    typeof rule?.name === "string" &&
    (rule.name === targetRuleName ||
      (rule.name.includes("reactive-execute") && rule.name.includes("parallel dispatch")));

  const duplicateEnforceIndexes: number[] = [];
  for (let i = 0; i < DISPATCH_RULES.length; i += 1) {
    if (DISPATCH_RULES[i]?.name === enforceWaveBreakdownRule.name) {
      duplicateEnforceIndexes.push(i);
    }
  }

  if (duplicateEnforceIndexes.length > 0) {
    for (const idx of [...duplicateEnforceIndexes].sort((a, b) => b - a)) {
      DISPATCH_RULES.splice(idx, 1);
    }
    logDispatchDiagnostic("patch-mount", "dedupe", "Removed stale enforce-wave-breakdown rules before remount", {
      removedCount: duplicateEnforceIndexes.length,
    });
  }

  const reactiveRuleIndex = DISPATCH_RULES.findIndex(isReactiveDispatchRule);

  if (reactiveRuleIndex === -1) {
    logDispatchDiagnostic("patch-mount", "target-rule-missing", "Failed to locate reactive-execute dispatch rule for takeover", {
      availableRules: DISPATCH_RULES
        .map((rule: any) => (typeof rule?.name === "string" ? rule.name : "<unnamed>"))
        .join(" | "),
    });
    return;
  }

  DISPATCH_RULES[reactiveRuleIndex] = waveReactiveRule;
  DISPATCH_RULES.splice(reactiveRuleIndex, 0, enforceWaveBreakdownRule);

  logDispatchDiagnostic("patch-mount", "mounted", "Forced dispatch takeover mounted successfully", {
    reactiveRuleIndex,
    enforcedParallel: FORCED_MAX_PARALLEL,
  });
}
