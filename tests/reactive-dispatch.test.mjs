import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import registerForcedReactiveDispatch from "../index.ts";

function createHarness() {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "explicit-reactive-core-"));
  const coreDir = join(runtimeRoot, "extensions", "gsd");
  mkdirSync(coreDir, { recursive: true });

  writeFileSync(
    join(coreDir, "auto-dispatch.js"),
    `export const DISPATCH_RULES = [
  { name: "executing → execute-task", match: async () => null },
  {
    name: "planning → plan-slice",
    match: async () => ({ action: "dispatch", unitType: "plan-slice", unitId: "legacy-plan", prompt: "legacy-plan" }),
  },
  {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async () => ({ action: "dispatch", unitType: "reactive-execute", unitId: "legacy", prompt: "legacy" }),
  },
];
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "gsd-db.js"),
    `const statuses = new Map();

export function __setTaskStatus(mid, sid, tid, status) {
  statuses.set(mid + "/" + sid + "/" + tid, status);
}

export function __resetDb() {
  statuses.clear();
}

export function isDbAvailable() {
  return true;
}

export function getTask(mid, sid, tid) {
  const status = statuses.get(mid + "/" + sid + "/" + tid);
  return status ? { status } : null;
}
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "auto-prompts.js"),
    `export async function buildReactiveExecutePrompt(mid, midTitle, sid, sTitle, selected) {
  return "prompt:" + mid + "/" + sid + ":" + selected.join(",");
}

export async function buildPlanSlicePrompt(mid, midTitle, sid, sTitle, basePath, _unused, options) {
  return "BASE_PLAN_PROMPT:" + mid + "/" + sid + (options?.priorPreExecFailure ? ":WITH_PREEXEC_FAILURE" : "");
}
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "reactive-graph.js"),
    `const saves = [];
const clears = [];

export function saveReactiveState(basePath, mid, sid, state) {
  saves.push({ basePath, mid, sid, state });
}

export function clearReactiveState(basePath, mid, sid) {
  clears.push({ basePath, mid, sid });
}

export function __getSaves() {
  return saves;
}

export function __getClears() {
  return clears;
}

export function __resetReactive() {
  saves.length = 0;
  clears.length = 0;
}
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "preferences-models.js"),
    `export function resolveModelWithFallbacksForUnit() {
  return { primary: "test-subagent-model" };
}
`,
    "utf-8",
  );

  return { runtimeRoot, coreDir };
}

function writeTaskPlan(tasksDir, taskId, body = "") {
  const content = `---\ntask_id: ${taskId}\n---\n\n# ${taskId}\n\n${body}\n`;
  writeFileSync(join(tasksDir, `${taskId}-PLAN.md`), content, "utf-8");
}

function writeWaveSidecar(sliceDir, sid, entries) {
  writeFileSync(
    join(sliceDir, `${sid}-TASK-WAVES.json`),
    `${JSON.stringify({ sliceId: sid, tasks: entries.map(({ task, wave, why }) => ({ taskId: task, wave, why: why ?? "" })) }, null, 2)}\n`,
    "utf-8",
  );
}

function createPiHarness() {
  const notifications = [];
  return {
    notifications,
    pi: {
      on(eventName, callback) {
        if (eventName === "session_start") {
          callback({}, { ui: { notify: (message, level) => notifications.push({ message, level }) } });
        }
      },
    },
  };
}

async function prepareRule() {
  const { runtimeRoot, coreDir } = createHarness();
  const { pi, notifications } = createPiHarness();
  const previousCoreDir = process.env.GSD_CODING_AGENT_DIR;
  process.env.GSD_CODING_AGENT_DIR = runtimeRoot;
  try {
    await registerForcedReactiveDispatch(pi);
  } finally {
    if (previousCoreDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = previousCoreDir;
  }

  const autoDispatch = await import(pathToFileURL(join(coreDir, "auto-dispatch.js")).href);
  const reactiveGraph = await import(pathToFileURL(join(coreDir, "reactive-graph.js")).href);
  const db = await import(pathToFileURL(join(coreDir, "gsd-db.js")).href);

  const planRule = autoDispatch.DISPATCH_RULES.find((entry) => entry?.name === "planning → plan-slice");
  assert.ok(planRule, "patched plan-slice rule should exist");

  const rule = autoDispatch.DISPATCH_RULES.find((entry) => entry?.name === "executing → reactive-execute (parallel dispatch)");
  assert.ok(rule, "patched reactive-execute rule should exist");

  const enforceRule = autoDispatch.DISPATCH_RULES.find((entry) => entry?.name === "executing → enforce-wave-breakdown");
  assert.ok(enforceRule, "wave sidecar enforcement rule should exist");

  return { planRule, rule, enforceRule, reactiveGraph, db, notifications };
}

async function runReactiveRule(rule, basePath, prefs = {}) {
  return rule.match({
    state: {
      phase: "executing",
      activeTask: { id: "T00", title: "placeholder" },
      activeSlice: { id: "S01", title: "Slice 01" },
    },
    mid: "M001",
    midTitle: "Milestone 001",
    basePath,
    prefs,
    sessionContextWindow: 64000,
    modelRegistry: {},
  });
}

test("initial plan-slice dispatch appends explicit wave sidecar prompt to the standard system prompt", async () => {
  const { planRule } = await prepareRule();

  const dispatch = await planRule.match({
    state: {
      phase: "planning",
      activeSlice: { id: "S01", title: "Slice 01" },
    },
    mid: "M001",
    midTitle: "Milestone 001",
    basePath: mkdtempSync(join(tmpdir(), "explicit-reactive-plan-")),
    sessionContextWindow: 64000,
    modelRegistry: {},
    session: {},
  });

  assert.ok(dispatch, "plan-slice rule should dispatch during planning");
  assert.equal(dispatch.unitType, "plan-slice");
  assert.equal(dispatch.unitId, "M001/S01");
  assert.match(dispatch.prompt, /BASE_PLAN_PROMPT:M001\/S01/, "prompt should retain the standard plan-slice prompt body");
  assert.match(dispatch.prompt, /Plugin overlay: explicit task waves/, "prompt should include the plugin sidecar overlay on first plan");
  assert.match(dispatch.prompt, /fine-grained, uniformly sized tasks/, "prompt should force fine-grained uniform task sizing");
  assert.match(dispatch.prompt, /Do not create one large implementation task/, "prompt should prohibit lopsided task decomposition");
  assert.match(dispatch.prompt, /\.gsd\/milestones\/M001\/slices\/S01\/S01-TASK-WAVES\.json/, "prompt should name the exact sidecar file");
  assert.match(dispatch.prompt, /"tasks": \[/, "prompt should require JSON task wave config");
  assert.match(dispatch.prompt, /Do not add `wave`, `waves`, `execution_wave`/, "prompt should prohibit non-native task frontmatter fields");
});

test("fallback wave rewrite dispatch sends only the sidecar repair prompt", async () => {
  const { enforceRule } = await prepareRule();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-rewrite-"));
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    `# S01\n\n## Goal\nHarden object-pool safety and deterministic optimization outputs.\n\n## Tasks\n- placeholder\n`,
    "utf-8",
  );
  writeTaskPlan(tasksDir, "T01", "Independent implementation task.");

  const dispatch = await enforceRule.match({
    state: {
      phase: "executing",
      activeSlice: { id: "S01", title: "Slice 01" },
    },
    mid: "M001",
    midTitle: "Milestone 001",
    basePath,
    sessionContextWindow: 64000,
    modelRegistry: {},
  });

  assert.ok(dispatch, "enforce-wave-breakdown should dispatch when the sidecar is missing");
  assert.equal(dispatch.unitType, "plan-slice", "fallback still reuses a plan-slice unit shell");
  assert.equal(dispatch.unitId, "M001/S01");
  assert.match(dispatch.prompt, /^# Repair explicit task waves sidecar/, "fallback prompt should be the plugin repair prompt");
  assert.doesNotMatch(dispatch.prompt, /BASE_PLAN_PROMPT:M001\/S01/, "fallback prompt must not resend the standard plan-slice prompt");
  assert.match(dispatch.prompt, /S01-TASK-WAVES\.json/, "repair prompt should name the canonical sidecar");
  assert.match(dispatch.prompt, /`T01-PLAN\.md`/, "repair prompt should include the current task plan set");
  assert.match(dispatch.prompt, /Harden object-pool safety and deterministic optimization outputs\./, "repair prompt should carry parsed goal text");
});

test("reactive batch selection reads waves from the single sidecar, is deterministic, truncated at 8, and persisted", async () => {
  const { rule, reactiveGraph, db } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const taskIds = ["T10", "T09", "T08", "T07", "T06", "T05", "T04", "T03", "T02", "T1", "T01"];
  for (const taskId of taskIds) {
    writeTaskPlan(tasksDir, taskId);
  }
  writeWaveSidecar(sliceDir, "S01", taskIds.map((task) => ({ task, wave: 1, why: "same wave for deterministic truncation test" })));

  // Closed statuses should be excluded from pending and included in completed.
  db.__setTaskStatus("M001", "S01", "T03", "complete");
  db.__setTaskStatus("M001", "S01", "T04", "skipped");

  const dispatch = await runReactiveRule(rule, basePath);
  assert.ok(dispatch, "reactive rule should dispatch a batch when sidecar wave has multiple runnable tasks");
  assert.equal(dispatch.unitType, "reactive-execute");
  assert.equal(
    dispatch.unitId,
    "M001/S01/reactive+T01,T1,T02,T05,T06,T07,T08,T09",
    "unitId should encode the deterministic, truncated batch",
  );

  const saves = reactiveGraph.__getSaves();
  assert.equal(saves.length, 1, "state should be persisted exactly once");

  const saved = saves[0];
  assert.equal(saved.mid, "M001");
  assert.equal(saved.sid, "S01");
  assert.deepEqual(saved.state.completed, ["T03", "T04"], "closed tasks should be persisted as completed in deterministic order");
  assert.deepEqual(
    saved.state.dispatched,
    ["T01", "T1", "T02", "T05", "T06", "T07", "T08", "T09"],
    "dispatched tasks should be sorted deterministically before truncation",
  );
  assert.equal(saved.state.graphSnapshot.taskCount, 11, "taskCount should reflect unique known tasks (pending + completed)");
  assert.equal(saved.state.graphSnapshot.readySetSize, 9, "readySetSize should reflect full current-wave runnable set before truncation");
  assert.equal(saved.state.graphSnapshot.edgeCount, 0);
  assert.equal(saved.state.graphSnapshot.ambiguous, false);

  const clears = reactiveGraph.__getClears();
  assert.equal(clears.length, 0, "state should not be cleared on successful reactive dispatch");
});

test("invalid/missing wave sidecar degrades safely: no dispatch, no state write, stale state cleared", async () => {
  const { rule, reactiveGraph, db, notifications } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeTaskPlan(tasksDir, "T01");
  writeTaskPlan(tasksDir, "T02");
  writeWaveSidecar(sliceDir, "S01", [{ task: "T01", wave: 1, why: "T02 intentionally missing" }]);

  // Seed one stale state entry to verify clearReactiveState fallback path is exercised.
  reactiveGraph.saveReactiveState(basePath, "M001", "S01", {
    sliceId: "S01",
    completed: ["T00"],
    dispatched: ["T00"],
    graphSnapshot: { taskCount: 1, edgeCount: 0, readySetSize: 1, ambiguous: false },
    updatedAt: new Date().toISOString(),
  });
  const saveCountBefore = reactiveGraph.__getSaves().length;

  const result = await runReactiveRule(rule, basePath);
  assert.equal(result, null, "rule should fall back to sequential path when sidecar metadata is invalid");

  const saveCountAfter = reactiveGraph.__getSaves().length;
  assert.equal(saveCountAfter, saveCountBefore, "invalid sidecar path must not write a new reactive state snapshot");

  const clears = reactiveGraph.__getClears();
  assert.equal(clears.length, 1, "invalid sidecar should clear stale reactive state to avoid pollution");
  assert.equal(clears[0].mid, "M001");
  assert.equal(clears[0].sid, "S01");

  const messages = notifications.map((entry) => entry.message).join("\n");
  assert.match(messages, /reactive-dispatch wave-sidecar-invalid/, "diagnostics should expose invalid sidecar cause");
  assert.match(messages, /wave-sidecar-task-set-mismatch/, "diagnostics should expose task set mismatch reason");
  assert.match(messages, /reactive-dispatch state-cleared/, "diagnostics should expose state clear fallback");
});

test("malformed JSON wave sidecar degrades safely with a parse diagnostic", async () => {
  const { rule, reactiveGraph, db, notifications } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeTaskPlan(tasksDir, "T01");
  writeTaskPlan(tasksDir, "T02");
  writeFileSync(join(sliceDir, "S01-TASK-WAVES.json"), "{ bad json\n", "utf-8");

  const result = await runReactiveRule(rule, basePath);
  assert.equal(result, null, "malformed JSON must not dispatch a reactive batch");
  assert.equal(reactiveGraph.__getSaves().length, 0, "malformed JSON must not write reactive state");
  assert.equal(reactiveGraph.__getClears().length, 1, "malformed JSON should clear stale reactive state");

  const messages = notifications.map((entry) => entry.message).join("\n");
  assert.match(messages, /json-invalid/, "diagnostics should expose malformed JSON");
});

test("when no pending sidecar wave tasks remain, reactive state is cleared instead of persisting stale batch data", async () => {
  const { rule, reactiveGraph, db, notifications } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeTaskPlan(tasksDir, "T01");
  writeTaskPlan(tasksDir, "T02");
  writeWaveSidecar(sliceDir, "S01", [
    { task: "T01", wave: 1, why: "done" },
    { task: "T02", wave: 1, why: "done" },
  ]);

  db.__setTaskStatus("M001", "S01", "T01", "done");
  db.__setTaskStatus("M001", "S01", "T02", "complete");

  const result = await runReactiveRule(rule, basePath);
  assert.equal(result, null, "no pending tasks should fall through to default sequential dispatch rule");

  assert.equal(reactiveGraph.__getSaves().length, 0, "no pending tasks should not write a new reactive state snapshot");
  assert.equal(reactiveGraph.__getClears().length, 1, "no pending tasks should clear stale state");
  const messages = notifications.map((entry) => entry.message).join("\n");
  assert.match(messages, /reason=no-pending-wave-tasks/, "diagnostics should explain why reactive state was cleared");
});

test("module import failure remains fail-loud with standardized plugin phase/cause diagnostics", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "explicit-reactive-broken-core-"));
  const coreDir = join(runtimeRoot, "extensions", "gsd");
  mkdirSync(coreDir, { recursive: true });

  writeFileSync(
    join(coreDir, "auto-dispatch.js"),
    `export const DISPATCH_RULES = [
  { name: "planning → plan-slice", match: async () => null },
  { name: "executing → reactive-execute (parallel dispatch)", match: async () => null },
];
`,
    "utf-8",
  );

  writeFileSync(join(coreDir, "gsd-db.js"), "export const broken = ;\n", "utf-8");

  writeFileSync(
    join(coreDir, "auto-prompts.js"),
    `export async function buildReactiveExecutePrompt() { return "noop"; }
export async function buildPlanSlicePrompt() { return "noop-plan"; }
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "reactive-graph.js"),
    `export function saveReactiveState() {}
export function clearReactiveState() {}
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "preferences-models.js"),
    `export function resolveModelWithFallbacksForUnit() { return { primary: "test-model" }; }
`,
    "utf-8",
  );

  const { pi, notifications } = createPiHarness();
  const previousCoreDir = process.env.GSD_CODING_AGENT_DIR;
  process.env.GSD_CODING_AGENT_DIR = runtimeRoot;

  try {
    await registerForcedReactiveDispatch(pi);

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.match(messages, /module-discovery core-path-selected/);
    assert.match(messages, /module-load core-modules-import-failed/);
    assert.doesNotMatch(messages, /patch-mount mounted/);
  } finally {
    if (previousCoreDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = previousCoreDir;
  }
});
