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
    name: "executing → reactive-execute (parallel dispatch)",
    match: async () => ({ action: "dispatch", unitType: "reactive-execute", unitId: "legacy", prompt: "legacy" }),
  },
];
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "files.js"),
    `export function splitFrontmatter(content) {
  if (!content.startsWith("---\\n")) return [null, content];
  const end = content.indexOf("\\n---\\n", 4);
  if (end === -1) return [null, content];
  const frontmatter = content.slice(4, end);
  const body = content.slice(end + "\\n---\\n".length);
  return [frontmatter, body];
}

export function parseFrontmatterMap(frontmatter) {
  const result = {};
  for (const rawLine of String(frontmatter).split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (/^[-+]?\\d+$/.test(rawValue)) {
      result[key] = Number(rawValue);
    } else {
      result[key] = rawValue;
    }
  }
  return result;
}
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "gsd-db.js"),
    `const statuses = new Map();

export function __setTaskStatus(mid, sid, tid, status) {
  statuses.set(\`\${mid}/\${sid}/\${tid}\`, status);
}

export function __resetDb() {
  statuses.clear();
}

export function isDbAvailable() {
  return true;
}

export function getTask(mid, sid, tid) {
  const status = statuses.get(\`\${mid}/\${sid}/\${tid}\`);
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

export async function buildPlanSlicePrompt(mid, midTitle, sid) {
  return "BASE_PLAN_PROMPT:" + mid + "/" + sid;
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

function writeTaskPlan(tasksDir, taskId, frontmatterLines) {
  const frontmatter = frontmatterLines.join("\n");
  const content = `---\n${frontmatter}\n---\n\n# ${taskId}\n`;
  writeFileSync(join(tasksDir, `${taskId}-PLAN.md`), content, "utf-8");
}

async function withCapturedStderr(fn) {
  let captured = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, cb) => {
    const value = typeof chunk === "string" ? chunk : chunk.toString(typeof encoding === "string" ? encoding : undefined);
    captured += value;
    if (typeof cb === "function") cb();
    return true;
  };

  try {
    const result = await fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function prepareRule() {
  const { runtimeRoot, coreDir } = createHarness();
  const previousCoreDir = process.env.GSD_CODING_AGENT_DIR;
  process.env.GSD_CODING_AGENT_DIR = runtimeRoot;
  try {
    await registerForcedReactiveDispatch({});
  } finally {
    if (previousCoreDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = previousCoreDir;
  }

  const autoDispatch = await import(pathToFileURL(join(coreDir, "auto-dispatch.js")).href);
  const reactiveGraph = await import(pathToFileURL(join(coreDir, "reactive-graph.js")).href);
  const db = await import(pathToFileURL(join(coreDir, "gsd-db.js")).href);

  const rule = autoDispatch.DISPATCH_RULES.find((entry) => entry?.name === "executing → reactive-execute (parallel dispatch)");
  assert.ok(rule, "patched reactive-execute rule should exist");

  const enforceRule = autoDispatch.DISPATCH_RULES.find((entry) => entry?.name === "executing → enforce-wave-breakdown");
  assert.ok(enforceRule, "wave rewrite enforcement rule should exist");

  return { rule, enforceRule, reactiveGraph, db };
}

async function runRule(rule, basePath, prefs = {}) {
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

test("wave rewrite dispatch reuses standard plan-slice unit with wave overlay constraints", async () => {
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
  writeTaskPlan(tasksDir, "T01", ["owner: planner"]); // wave missing => force rewrite dispatch

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

  assert.ok(dispatch, "enforce-wave-breakdown should dispatch when wave metadata is missing");
  assert.equal(dispatch.unitType, "plan-slice", "rewrite should reuse standard plan-slice unit type");
  assert.equal(dispatch.unitId, "M001/S01", "rewrite should reuse standard plan-slice unit id");
  assert.match(dispatch.prompt, /Wave Execution Constraint/, "prompt should include wave overlay header");
  assert.match(dispatch.prompt, /gsd_plan_slice/, "overlay should reinforce gsd_plan_slice persistence");
  assert.match(dispatch.prompt, /BASE_PLAN_PROMPT:M001\/S01/, "prompt should include standard plan-slice prompt body");
  assert.match(
    dispatch.prompt,
    /Harden object-pool safety and deterministic optimization outputs\./,
    "overlay should carry parsed goal text from the existing slice plan",
  );
});

test("reactive batch selection is deterministic, truncated at 8, and persisted with stable state semantics", async () => {
  const { rule, reactiveGraph, db } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const tasksDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // Intentionally unsorted file creation order.
  for (const taskId of ["T10", "T09", "T08", "T07", "T06", "T05", "T04", "T03", "T02", "T1", "T01"]) {
    writeTaskPlan(tasksDir, taskId, ["wave: 1"]);
  }

  // Closed statuses should be excluded from pending and included in completed.
  db.__setTaskStatus("M001", "S01", "T03", "complete");
  db.__setTaskStatus("M001", "S01", "T04", "skipped");

  const dispatch = await runRule(rule, basePath);
  assert.ok(dispatch, "reactive rule should dispatch a batch when wave has multiple runnable tasks");
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

test("invalid/missing wave metadata degrades safely: no dispatch, no state write, stale state cleared", async () => {
  const { rule, reactiveGraph, db } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const tasksDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeTaskPlan(tasksDir, "T01", ["wave: 1"]);
  writeTaskPlan(tasksDir, "T02", ["owner: planner"]); // wave missing on purpose

  // Seed one stale state entry to verify clearReactiveState fallback path is exercised.
  reactiveGraph.saveReactiveState(basePath, "M001", "S01", {
    sliceId: "S01",
    completed: ["T00"],
    dispatched: ["T00"],
    graphSnapshot: { taskCount: 1, edgeCount: 0, readySetSize: 1, ambiguous: false },
    updatedAt: new Date().toISOString(),
  });
  const saveCountBefore = reactiveGraph.__getSaves().length;

  const { result, stderr } = await withCapturedStderr(() => runRule(rule, basePath));
  assert.equal(result, null, "rule should fall back to sequential path when wave metadata is invalid");

  const saveCountAfter = reactiveGraph.__getSaves().length;
  assert.equal(saveCountAfter, saveCountBefore, "invalid metadata path must not write a new reactive state snapshot");

  const clears = reactiveGraph.__getClears();
  assert.equal(clears.length, 1, "invalid metadata should clear stale reactive state to avoid pollution");
  assert.equal(clears[0].mid, "M001");
  assert.equal(clears[0].sid, "S01");

  assert.match(stderr, /phase=reactive-dispatch cause=wave-metadata-invalid/, "diagnostics should expose invalid wave metadata cause");
  assert.match(stderr, /phase=reactive-dispatch cause=state-cleared/, "diagnostics should expose state clear fallback");
});

test("when no pending wave tasks remain, reactive state is cleared instead of persisting stale batch data", async () => {
  const { rule, reactiveGraph, db } = await prepareRule();
  db.__resetDb();
  reactiveGraph.__resetReactive();

  const basePath = mkdtempSync(join(tmpdir(), "explicit-reactive-repo-"));
  const tasksDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeTaskPlan(tasksDir, "T01", ["wave: 1"]);
  writeTaskPlan(tasksDir, "T02", ["wave: 1"]);

  db.__setTaskStatus("M001", "S01", "T01", "done");
  db.__setTaskStatus("M001", "S01", "T02", "complete");

  const { result, stderr } = await withCapturedStderr(() => runRule(rule, basePath));
  assert.equal(result, null, "no pending tasks should fall through to default sequential dispatch rule");

  assert.equal(reactiveGraph.__getSaves().length, 0, "no pending tasks should not write a new reactive state snapshot");
  assert.equal(reactiveGraph.__getClears().length, 1, "no pending tasks should clear stale state");
  assert.match(stderr, /reason=no-pending-wave-tasks/, "diagnostics should explain why reactive state was cleared");
});

test("module import failure remains fail-loud with standardized plugin/phase/cause diagnostics", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "explicit-reactive-broken-core-"));
  const coreDir = join(runtimeRoot, "extensions", "gsd");
  mkdirSync(coreDir, { recursive: true });

  writeFileSync(
    join(coreDir, "auto-dispatch.js"),
    `export const DISPATCH_RULES = [
  { name: "executing → reactive-execute (parallel dispatch)", match: async () => null },
];
`,
    "utf-8",
  );

  writeFileSync(
    join(coreDir, "files.js"),
    `export function splitFrontmatter(content) { return [null, content]; }
export function parseFrontmatterMap() { return {}; }
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

  const previousCoreDir = process.env.GSD_CODING_AGENT_DIR;
  process.env.GSD_CODING_AGENT_DIR = runtimeRoot;

  try {
    const { stderr } = await withCapturedStderr(() => registerForcedReactiveDispatch({}));

    assert.match(stderr, /plugin=gsd-explicit-reactive phase=module-discovery cause=core-path-selected/);
    assert.match(stderr, /plugin=gsd-explicit-reactive phase=module-load cause=core-modules-import-failed/);
    assert.doesNotMatch(stderr, /phase=patch-mount cause=mounted/);
  } finally {
    if (previousCoreDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = previousCoreDir;
  }
});
