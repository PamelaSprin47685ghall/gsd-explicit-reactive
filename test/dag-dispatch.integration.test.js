import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectExplicitDagEngine } from "../src/engine.js";

function createTempBase() {
  return mkdtempSync(join(tmpdir(), "dag-dispatch-"));
}

function writeDeps(basePath, deps) {
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "DEPS.json"), JSON.stringify(deps, null, 2), "utf-8");
}

function createCoreWithRules(tasks) {
  const planRule = {
    name: "planning → plan-slice",
    match: async () => ({
      action: "dispatch",
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "base plan prompt",
    }),
  };

  const reactiveRule = {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async () => ({ action: "dispatch", unitType: "reactive-execute" }),
  };

  const executeRecoverRule = {
    name: "executing → execute-task (recover missing task plan → plan-slice)",
    match: async () => ({ action: "dispatch", unitType: "plan-slice", unitId: "M001/S01" }),
  };
  const executeRule = {
    name: "executing → execute-task",
    match: async () => ({ action: "dispatch", unitType: "execute-task" }),
  };

  const rules = [planRule, reactiveRule, executeRecoverRule, executeRule];

  const core = {
    "auto-dispatch": { DISPATCH_RULES: rules },
    "rule-registry": {
      initRegistry: () => undefined,
      convertDispatchRules: (dispatchRules) => dispatchRules.map((rule) => ({
        name: rule.name,
        when: "dispatch",
        where: rule.match,
        then: (result) => result,
      })),
    },
    "gsd-db": {
      isDbAvailable: () => true,
      getSliceTasks: () => tasks,
      updateTaskStatus: () => undefined,
    },
  };

  return { core, rules };
}

function createCtx(basePath) {
  const notifications = [];
  return {
    ctx: {
      mid: "M001",
      basePath,
      state: {
        phase: "executing",
        activeSlice: {
          id: "S01",
          title: "Slice 01",
          goal: "Ship parallel execution",
        },
      },
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
      },
      sessionManager: {
        getSessionId: () => "session-1",
      },
    },
    notifications,
  };
}

describe("dag dispatch integration", () => {
  it("dispatches dag-execution when deps are valid and ready tasks > 1", async () => {
    const basePath = createTempBase();

    try {
      writeDeps(basePath, {
        version: 1,
        tasks: {
          T01: { depends_on: [] },
          T02: { depends_on: [] },
          T03: { depends_on: ["T01"] },
        },
      });

      const tasks = [
        { id: "T01", title: "Task 1", status: "pending" },
        { id: "T02", title: "Task 2", status: "pending" },
        { id: "T03", title: "Task 3", status: "pending" },
      ];

      const { core, rules } = createCoreWithRules(tasks);
      const registerToolCalls = [];
      const pi = {
        registerTool: (tool) => registerToolCalls.push(tool.name),
      };

      injectExplicitDagEngine(core, pi, undefined, new Map(), new Map());

      const dagRule = rules.find((rule) => rule.name === "executing → dag-execution");
      assert.ok(dagRule, "dag rule should be injected");

      const { ctx } = createCtx(basePath);
      const result = await dagRule.match(ctx);

      assert.ok(result);
      assert.strictEqual(result.action, "dispatch");
      assert.strictEqual(result.unitType, "dag-execution");
      assert.ok(result.unitId.startsWith("M001/S01/dag+"));
      assert.ok(result.prompt.includes("_wait_for_dag_completion"));
      assert.ok(registerToolCalls.includes("_wait_for_dag_completion"));
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  it("falls back to plan-slice when DEPS is invalid", async () => {
    const basePath = createTempBase();

    try {
      writeDeps(basePath, {
        version: 1,
        tasks: {
          T01: { depends_on: [] },
        },
      });

      const tasks = [
        { id: "T01", title: "Task 1", status: "pending" },
        { id: "T02", title: "Task 2", status: "pending" },
      ];

      const { core, rules } = createCoreWithRules(tasks);
      const pi = { registerTool: () => undefined };
      injectExplicitDagEngine(core, pi, undefined, new Map(), new Map());

      const dagRule = rules.find((rule) => rule.name === "executing → dag-execution");
      assert.ok(dagRule, "dag rule should be injected");

      const { ctx } = createCtx(basePath);
      const result = await dagRule.match(ctx);

      assert.ok(result);
      assert.strictEqual(result.action, "dispatch");
      assert.strictEqual(result.unitType, "plan-slice");
      assert.ok(result.prompt.includes("PLAN REJECTED: DEPS.json ERROR"));
      assert.ok(result.prompt.includes("Missing task in DEPS.tasks: T02"));
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});
