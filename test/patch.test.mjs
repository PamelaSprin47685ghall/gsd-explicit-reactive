import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { withTmp, makeTaskPlan, makeWaves } from "./helpers.mjs";

function makeMockCore(withDb) {
  const core = {
    "auto-dispatch": {
      DISPATCH_RULES: [
        { name: "planning → plan-slice", match: async () => ({ prompt: "Base", mid: "M01", state: { activeSlice: { id: "S01" } } }) },
        { name: "executing → reactive-execute (parallel dispatch)", match: async () => null }
      ]
    },
    "reactive-graph": { clearReactiveState: () => {}, saveReactiveState: () => {} },
    "auto-prompts": { buildReactiveExecutePrompt: async () => "Exec prompt" },
    "preferences-models": { resolveModelWithFallbacksForUnit: () => null }
  };
  if (withDb) {
    core["gsd-db"] = {
      isDbAvailable: () => true,
      getTask: () => null
    };
  } else {
    core["gsd-db"] = { isDbAvailable: () => false };
  }
  return core;
}

test("patch", async (t) => {
  await t.test("patches plan-slice rule to inject WAVES.json requirement", async () => {
    const core = makeMockCore();
    const notifications = [];
    const capturedCtx = { ui: { notify: (msg) => notifications.push(msg) } };

    const { patchDispatchRules } = await import("../src/patch.js");
    patchDispatchRules(core, {}, capturedCtx);

    const rules = core["auto-dispatch"].DISPATCH_RULES;
    const planRule = rules.find(r => r.name === "planning → plan-slice");
    const result = await planRule.match({ mid: "M01", state: { activeSlice: { id: "S01" } } });
    assert.ok(result.prompt.includes("WAVES.json"), "should inject WAVES.json requirement");
    assert.ok(result.prompt.includes("Max"), "should mention concurrency limit");
  });

  await t.test("replaces reactive-execute with enforce + reactive rules", async () => {
    const core = makeMockCore();
    const { patchDispatchRules } = await import("../src/patch.js");
    patchDispatchRules(core, {}, { ui: { notify: () => {} } });

    const rules = core["auto-dispatch"].DISPATCH_RULES;
    assert.ok(rules.find(r => r.name === "executing → enforce-explicit-waves"));
    assert.ok(rules.find(r => r.name === "executing → explicit-reactive-execute (parallel dispatch)"));
    assert.ok(!rules.find(r => r.name.includes("reactive-execute (parallel dispatch)") &&
      !r.name.includes("explicit-")));
  });

  await t.test("enforce-explicit-waves returns repair prompt when WAVES.json missing", async () => {
    const core = makeMockCore();
    const { patchDispatchRules } = await import("../src/patch.js");
    patchDispatchRules(core, {}, { ui: { notify: () => {} } });

    const enforceRule = core["auto-dispatch"].DISPATCH_RULES
      .find(r => r.name === "executing → enforce-explicit-waves");
    const result = await enforceRule.match({
      state: { phase: "executing", activeSlice: { id: "S01" } },
      mid: "M01",
      basePath: "/nonexistent"
    });
    assert.ok(result, "should return dispatch action");
    assert.strictEqual(result.unitType, "plan-slice");
    assert.ok(result.prompt.includes("WAVES.json is missing"));
  });

  await t.test("enforce-explicit-waves returns null when WAVES.json valid", async () => {
    await withTmp(async tmp => {
      const core = makeMockCore();
      const { patchDispatchRules } = await import("../src/patch.js");
      patchDispatchRules(core, {}, { ui: { notify: () => {} } });

      const slicesDir = path.join(tmp, ".gsd", "milestones", "M01", "slices", "S01");
      makeTaskPlan(path.join(slicesDir, "tasks"), "T01");
      makeWaves(slicesDir, { T01: 1 });

      const enforceRule = core["auto-dispatch"].DISPATCH_RULES
        .find(r => r.name === "executing → enforce-explicit-waves");
      const result = await enforceRule.match({
        state: { phase: "executing", activeSlice: { id: "S01" } },
        mid: "M01",
        basePath: tmp
      });
      assert.strictEqual(result, null);
    });
  });
});
