import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { injectExplicitDagEngine } from "../src/engine.js";

function createMockCore() {
  const planRule = {
    name: "planning → plan-slice",
    match: async () => ({ prompt: "plan prompt" }),
  };
  const reactiveRule = {
    name: "executing → reactive-execute (parallel dispatch)",
    match: async () => ({ action: "dispatch", unitType: "reactive-execute" }),
  };
  const executeRule = {
    name: "executing → execute-task",
    match: async () => ({ action: "dispatch", unitType: "execute-task" }),
  };

  const rules = [planRule, reactiveRule, executeRule];

  const initRegistry = mock.fn(() => undefined);
  const convertDispatchRules = mock.fn((dispatchRules) => dispatchRules.map((rule) => ({
    name: rule.name,
    when: "dispatch",
    where: rule.match,
    then: (result) => result,
  })));

  return {
    core: {
      "auto-dispatch": { DISPATCH_RULES: rules },
      "rule-registry": { initRegistry, convertDispatchRules },
      "gsd-db": { isDbAvailable: () => false },
    },
    rules,
    initRegistry,
    convertDispatchRules,
  };
}

describe("injectExplicitDagEngine", () => {
  it("should disable official execution rules and inject dag rule", async () => {
    const { core, rules } = createMockCore();
    const registerTool = mock.fn(() => undefined);
    const pi = { registerTool };

    injectExplicitDagEngine(core, pi, undefined, new Map(), new Map());

    const dagRules = rules.filter((rule) => rule.name === "executing → dag-execution");
    assert.strictEqual(dagRules.length, 1);

    const disabledReactive = rules.find((rule) => String(rule.name).includes("reactive-execute"));
    const disabledExecute = rules.find((rule) => String(rule.name).includes("execute-task"));

    assert.ok(disabledReactive.name.startsWith("[DAG Disabled]"));
    assert.ok(disabledExecute.name.startsWith("[DAG Disabled]"));

    const reactiveResult = await disabledReactive.match({});
    const executeResult = await disabledExecute.match({});
    assert.strictEqual(reactiveResult, null);
    assert.strictEqual(executeResult, null);

    const planRule = rules.find((rule) => String(rule.name).includes("plan-slice"));
    const planResult = await planRule.match({});
    assert.ok(planResult.prompt.includes("DEPS.json"));

    assert.strictEqual(registerTool.mock.calls.length, 1);
  });

  it("should sync rule registry through public API and remain idempotent", () => {
    const { core, rules, initRegistry, convertDispatchRules } = createMockCore();
    const registerTool = mock.fn(() => undefined);
    const pi = { registerTool };

    injectExplicitDagEngine(core, pi, undefined, new Map(), new Map());
    injectExplicitDagEngine(core, pi, undefined, new Map(), new Map());

    const dagRules = rules.filter((rule) => rule.name === "executing → dag-execution");
    assert.strictEqual(dagRules.length, 1);

    const planRule = rules.find((rule) => String(rule.name).includes("plan-slice"));
    assert.ok(planRule._dagPatched);

    assert.ok(convertDispatchRules.mock.calls.length >= 1);
    assert.ok(initRegistry.mock.calls.length >= 1);

    // Wait tool should only register once per pi instance.
    assert.strictEqual(registerTool.mock.calls.length, 1);
  });
});
