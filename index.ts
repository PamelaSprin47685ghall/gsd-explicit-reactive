import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_NAME = "gsd-explicit-reactive";
const FORCED_MAX_PARALLEL = 8;
const TASK_ID_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const REQUIRED_MODULES = [
  "auto-dispatch",
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

let capturedCtx: any = null;

function logDispatchDiagnostic(
  phase: string,
  cause: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  if (!capturedCtx?.ui?.notify) return;
  const detailPairs = Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  const suffix = detailPairs.length > 0 ? ` ${detailPairs.join(" ")}` : "";
  capturedCtx.ui.notify(
    `[dispatch] ${phase} ${cause} ${message}${suffix}`,
    "info"
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

const WAVE_CONFIG_SUFFIX = "-TASK-WAVES.json";
const LEGACY_WAVE_SIDECAR_SUFFIX = "-TASK-WAVES.md";

type WaveParseFailure = {
  reason: string;
  detail?: string;
};

type WavePlanResult =
  | { ok: true; path: string; relPath: string; waves: Map<string, number> }
  | { ok: false; path: string; relPath: string; reason: string; detail?: string };

function waveSidecarFileName(sid: string): string {
  return `${sid}${WAVE_CONFIG_SUFFIX}`;
}

function waveSidecarAbsPath(basePath: string, mid: string, sid: string): string {
  return join(basePath, ".gsd", "milestones", mid, "slices", sid, waveSidecarFileName(sid));
}

function waveSidecarRelPath(mid: string, sid: string): string {
  return join(".gsd", "milestones", mid, "slices", sid, waveSidecarFileName(sid));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWaveNumber(rawWave: unknown): { wave: number | null; reason: string | null } {
  if (typeof rawWave !== "number" || !Number.isInteger(rawWave)) {
    return { wave: null, reason: "wave-non-integer" };
  }
  if (!Number.isSafeInteger(rawWave)) {
    return { wave: null, reason: "wave-unsafe-integer" };
  }
  if (rawWave < 1) {
    return { wave: null, reason: "wave-out-of-range" };
  }

  return { wave: rawWave, reason: null };
}

function parseTaskId(rawTaskId: unknown): { taskId: string | null; reason: string | null } {
  if (typeof rawTaskId !== "string") {
    return { taskId: null, reason: "task-id-missing" };
  }

  const taskId = rawTaskId.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return { taskId: null, reason: "task-id-invalid" };
  }

  return { taskId, reason: null };
}

function parseWaveSidecar(content: string, sid: string): { waves: Map<string, number>; failures: WaveParseFailure[] } {
  const waves = new Map<string, number>();
  const failures: WaveParseFailure[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { waves, failures: [{ reason: "json-invalid", detail: errMessage(err) }] };
  }

  if (!isJsonRecord(parsed)) {
    return { waves, failures: [{ reason: "root-not-object" }] };
  }

  if (parsed.sliceId !== sid) {
    return { waves, failures: [{ reason: "slice-id-mismatch", detail: String(parsed.sliceId) }] };
  }

  if (!Array.isArray(parsed.tasks)) {
    return { waves, failures: [{ reason: "tasks-not-array" }] };
  }

  if (parsed.tasks.length === 0) {
    return { waves, failures: [{ reason: "no-wave-tasks" }] };
  }

  for (const [index, rawTask] of parsed.tasks.entries()) {
    if (!isJsonRecord(rawTask)) {
      failures.push({ reason: "task-entry-not-object", detail: String(index) });
      continue;
    }

    const parsedTaskId = parseTaskId(rawTask.taskId);
    if (parsedTaskId.taskId === null) {
      failures.push({ reason: parsedTaskId.reason ?? "task-id-invalid", detail: String(index) });
      continue;
    }

    const parsedWave = parseWaveNumber(rawTask.wave);
    if (parsedWave.wave === null) {
      failures.push({ reason: parsedWave.reason ?? "wave-invalid", detail: `${parsedTaskId.taskId}:${String(rawTask.wave)}` });
      continue;
    }

    if (rawTask.why !== undefined && typeof rawTask.why !== "string") {
      failures.push({ reason: "why-not-string", detail: parsedTaskId.taskId });
      continue;
    }

    if (waves.has(parsedTaskId.taskId)) {
      failures.push({ reason: "task-duplicated", detail: parsedTaskId.taskId });
      continue;
    }

    waves.set(parsedTaskId.taskId, parsedWave.wave);
  }

  return { waves, failures };
}

function loadWavePlan(basePath: string, mid: string, sid: string, taskIds: string[]): WavePlanResult {
  const sliceDir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  const expectedFileName = waveSidecarFileName(sid);
  const expectedPath = waveSidecarAbsPath(basePath, mid, sid);
  const expectedRelPath = waveSidecarRelPath(mid, sid);

  let sidecars: string[] = [];
  try {
    sidecars = readdirSync(sliceDir).filter(
      (file) => file.endsWith(WAVE_CONFIG_SUFFIX) || file.endsWith(LEGACY_WAVE_SIDECAR_SUFFIX),
    );
  } catch (err) {
    return {
      ok: false,
      path: expectedPath,
      relPath: expectedRelPath,
      reason: "slice-dir-read-failed",
      detail: errMessage(err),
    };
  }

  if (sidecars.length === 0) {
    return { ok: false, path: expectedPath, relPath: expectedRelPath, reason: "wave-sidecar-missing" };
  }

  if (sidecars.length !== 1 || sidecars[0] !== expectedFileName) {
    return {
      ok: false,
      path: expectedPath,
      relPath: expectedRelPath,
      reason: "wave-sidecar-count-invalid",
      detail: sidecars.sort().join(",") || "<none>",
    };
  }

  let content = "";
  try {
    content = readFileSync(expectedPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      path: expectedPath,
      relPath: expectedRelPath,
      reason: "wave-sidecar-read-failed",
      detail: errMessage(err),
    };
  }

  const parsed = parseWaveSidecar(content, sid);
  if (parsed.failures.length > 0) {
    return {
      ok: false,
      path: expectedPath,
      relPath: expectedRelPath,
      reason: "wave-sidecar-parse-failed",
      detail: parsed.failures.map((failure) => `${failure.reason}${failure.detail ? `:${failure.detail}` : ""}`).join(" | "),
    };
  }

  const known = new Set(taskIds);
  const unknown = [...parsed.waves.keys()].filter((taskId) => !known.has(taskId)).sort(compareTaskIds);
  const missing = taskIds.filter((taskId) => !parsed.waves.has(taskId)).sort(compareTaskIds);

  if (unknown.length > 0 || missing.length > 0) {
    return {
      ok: false,
      path: expectedPath,
      relPath: expectedRelPath,
      reason: "wave-sidecar-task-set-mismatch",
      detail: `missing=${missing.join(",") || "<none>"}; unknown=${unknown.join(",") || "<none>"}`,
    };
  }

  return { ok: true, path: expectedPath, relPath: expectedRelPath, waves: parsed.waves };
}

function extractGoalFromPlan(content: string): string | null {
  const normalized = String(content || "");
  const goalHeading = normalized.match(/^##\s+Goal\s*$/im);
  if (!goalHeading || goalHeading.index === undefined) return null;

  const afterHeading = normalized.slice(goalHeading.index + goalHeading[0].length);
  const boundaryMatch = afterHeading.match(/\n##\s+/);
  const goalBlock = (boundaryMatch ? afterHeading.slice(0, boundaryMatch.index) : afterHeading).trim();
  if (!goalBlock) return null;

  const firstNonEmpty = goalBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmpty) return null;
  return firstNonEmpty.replace(/^[-*]\s+/, "").trim() || null;
}

function readSliceGoalOrFallback(basePath: string, mid: string, sid: string, fallback: string): string {
  const planPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, `${sid}-PLAN.md`);
  try {
    const content = readFileSync(planPath, "utf-8");
    const parsed = extractGoalFromPlan(content);
    if (parsed) return parsed;

    logDispatchDiagnostic("wave-rewrite", "goal-missing-in-plan", "Slice plan is missing a parseable Goal section; using fallback title", {
      mid,
      sid,
      planPath,
      fallback,
    });
    return fallback;
  } catch (err) {
    logDispatchDiagnostic("wave-rewrite", "goal-read-failed", "Failed to read slice plan while extracting goal; using fallback title", {
      mid,
      sid,
      planPath,
      fallback,
      error: errMessage(err),
    });
    return fallback;
  }
}

function buildWaveSidecarInitialPrompt(mid: string, sid: string): string {
  const sidecarRelPath = waveSidecarRelPath(mid, sid);
  return [
    "## Plugin overlay: explicit task waves for parallel execution",
    "",
    "Keep all normal GSD plan-slice requirements from the prompt above. In addition, record the parallel execution plan in a dedicated JSON sidecar file instead of task frontmatter.",
    "",
    "Required behavior:",
    "1. Plan the slice normally and call `gsd_plan_slice` with the task list.",
    "2. Break the slice into fine-grained, uniformly sized tasks before calling `gsd_plan_slice`. Split any task that would dominate a wave into smaller observable tasks.",
    "3. Keep task effort evenly distributed. Do not create one large implementation task plus several small cleanup or verification tasks; if a task cannot be made comparable in size, explain why in that task plan and place it in the appropriate later wave.",
    `4. After task plan files exist, create or replace exactly one JSON wave sidecar file: \`${sidecarRelPath}\`.`,
    "5. Do not add `wave`, `waves`, `execution_wave`, or any other plugin-only field to task-plan frontmatter. The JSON sidecar is the only source of wave metadata.",
    "6. Every `tasks/Txx-PLAN.md` in this slice must appear exactly once in the sidecar; do not include unknown task IDs.",
    `7. Assign positive integer waves. Tasks in the same wave must be safe to execute concurrently; put dependent tasks, integration checks, and regression verification in later waves. Prefer useful parallelism up to ${FORCED_MAX_PARALLEL} tasks per wave, but choose correctness over concurrency.`,
    "8. Do not create Markdown wave sidecars. Remove any legacy `*-TASK-WAVES.md` file for this slice if one exists.",
    "",
    "Use this exact JSON shape:",
    "",
    "```json",
    "{",
    `  \"sliceId\": \"${sid}\",`,
    "  \"tasks\": [",
    "    { \"taskId\": \"T01\", \"wave\": 1, \"why\": \"Independent setup or implementation work.\" },",
    "    { \"taskId\": \"T02\", \"wave\": 1, \"why\": \"Independent of T01; can run in parallel.\" },",
    "    { \"taskId\": \"T03\", \"wave\": 2, \"why\": \"Depends on wave 1 outputs or performs integration verification.\" }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

function buildWaveSidecarRepairPrompt(params: {
  mid: string;
  sid: string;
  sTitle: string;
  sliceGoal: string;
  taskIds: string[];
  wavePlan: WavePlanResult;
}): string {
  const { mid, sid, sTitle, sliceGoal, taskIds, wavePlan } = params;
  return [
    "# Repair explicit task waves sidecar",
    "",
    "This is a fallback repair dispatch from the `gsd-explicit-reactive` plugin. Do not redo the full plan-slice prompt; repair only the JSON wave sidecar unless you discover that the task plans themselves are missing.",
    "",
    `- Milestone: ${mid}`,
    `- Slice: ${sid} — ${sTitle}`,
    `- Slice goal baseline: ${sliceGoal}`,
    `- Required sidecar path: \`${wavePlan.relPath}\``,
    `- Current diagnostic: ${wavePlan.reason}${wavePlan.detail ? ` (${wavePlan.detail})` : ""}`,
    `- Current task plan files: ${taskIds.length > 0 ? taskIds.map((taskId) => `\`${taskId}-PLAN.md\``).join(", ") : "(none found)"}`,
    "",
    "Required repair:",
    `1. Create or replace exactly one file at \`${wavePlan.relPath}\`. If another \`*${WAVE_CONFIG_SUFFIX}\` file or legacy \`*${LEGACY_WAVE_SIDECAR_SUFFIX}\` file exists in this slice directory, remove it so the canonical JSON file is the only sidecar.`,
    "2. Use a JSON object with `sliceId` and `tasks` fields. `tasks` must be an array of objects shaped as `{ \"taskId\": \"T01\", \"wave\": 1, \"why\": \"...\" }`.",
    "3. Include every listed task exactly once and no unknown task IDs.",
    "4. Use positive integer waves only. Tasks in the same wave must be safe for concurrent execution; place dependent, integration, and regression tasks in later waves.",
    "5. Do not add or modify wave metadata in any task-plan frontmatter. The JSON sidecar is the sole wave source.",
    "6. If task dependencies are unclear, read the listed task plan files and choose conservative later waves rather than unsafe parallelism.",
    "7. If you discover missing task plans while repairing, create only fine-grained, uniformly sized tasks; do not merge work into a coarse catch-all task.",
  ].join("\n");
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
  pi.on("session_start", async (_event, ctx) => {
    capturedCtx = ctx;
  });

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

  if (typeof promptsModule?.buildPlanSlicePrompt !== "function") {
    logDispatchDiagnostic("module-load", "contract-mismatch", "auto-prompts missing buildPlanSlicePrompt", {
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

  const initialWavePlanRule = {
    name: "planning → plan-slice",
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, session }: any) => {
      if (state.phase !== "planning") return null;
      if (!state.activeSlice) {
        return {
          action: "stop",
          reason: `${mid}: phase "${state.phase}" has no active slice — run /gsd doctor.`,
          level: "error",
        };
      }

      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const unitId = `${mid}/${sid}`;
      let priorPreExecFailure;
      if (session?.lastPreExecFailure?.unitId === unitId) {
        priorPreExecFailure = {
          blockingFindings: session.lastPreExecFailure.blockingFindings,
          verdictExcerpt: session.lastPreExecFailure.verdictExcerpt,
        };
        session.lastPreExecFailure = null;
      }

      const standardPlanPrompt = await promptsModule.buildPlanSlicePrompt(
        mid,
        midTitle,
        sid,
        sTitle,
        basePath,
        undefined,
        { sessionContextWindow, modelRegistry, priorPreExecFailure },
      );

      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId,
        prompt: `${standardPlanPrompt}\n\n---\n\n${buildWaveSidecarInitialPrompt(mid, sid)}`,
      };
    },
  };

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
        logDispatchDiagnostic("wave-rewrite", "tasks-dir-read-failed", "Unable to scan task plans for wave sidecar gate", {
          mid,
          sid,
          tasksDir,
          error: errMessage(err),
        });
        return null;
      }

      const taskIds = files
        .map((file) => taskIdFromPlanFile(file) ?? file.replace("-PLAN.md", ""))
        .sort(compareTaskIds);
      const wavePlan = loadWavePlan(basePath, mid, sid, taskIds);
      if (wavePlan.ok) return null;

      logDispatchDiagnostic("wave-rewrite", wavePlan.reason, "Detected missing or invalid task wave sidecar; dispatching fallback repair prompt", {
        mid,
        sid,
        sidecar: wavePlan.relPath,
        taskPlanCount: taskIds.length,
        detail: wavePlan.detail,
      });

      const sliceGoal = readSliceGoalOrFallback(basePath, mid, sid, sTitle);
      const unitId = `${mid}/${sid}`;

      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId,
        prompt: buildWaveSidecarRepairPrompt({
          mid,
          sid,
          sTitle,
          sliceGoal,
          taskIds,
          wavePlan,
        }),
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

      const taskIds = files
        .map((file) => taskIdFromPlanFile(file) ?? file.replace("-PLAN.md", ""))
        .sort(compareTaskIds);
      const wavePlan = loadWavePlan(basePath, mid, sid, taskIds);
      if (!wavePlan.ok) {
        logDispatchDiagnostic("reactive-dispatch", "wave-sidecar-invalid", "Skipping forced reactive dispatch due to missing or invalid task wave sidecar", {
          mid,
          sid,
          fallback: "sequential",
          sidecar: wavePlan.relPath,
          reason: wavePlan.reason,
          detail: wavePlan.detail,
        });

        clearReactiveStateSafely(reactiveGraph, basePath, mid, sid, "invalid-wave-sidecar", {
          reason: wavePlan.reason,
        });
        return null;
      }

      const completed = new Set<string>();
      const pendingTasks: Array<{ id: string; wave: number }> = [];
      const dbAvailable = typeof dbModule?.isDbAvailable === "function" && dbModule.isDbAvailable();

      for (const tid of taskIds) {
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

        pendingTasks.push({ id: tid, wave: wavePlan.waves.get(tid)! });
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

  const planRuleIndex = DISPATCH_RULES.findIndex((rule: any) => rule?.name === initialWavePlanRule.name);
  if (planRuleIndex === -1) {
    logDispatchDiagnostic("patch-mount", "plan-rule-missing", "Failed to locate plan-slice dispatch rule for wave sidecar prompt overlay", {
      availableRules: DISPATCH_RULES
        .map((rule: any) => (typeof rule?.name === "string" ? rule.name : "<unnamed>"))
        .join(" | "),
    });
    return;
  }

  DISPATCH_RULES[planRuleIndex] = initialWavePlanRule;

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
    planRuleIndex,
    reactiveRuleIndex,
    enforcedParallel: FORCED_MAX_PARALLEL,
    waveSidecar: waveSidecarFileName("<slice>"),
  });
}
