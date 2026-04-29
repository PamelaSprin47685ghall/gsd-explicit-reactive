import test from "node:test";
import assert from "node:assert/strict";
import { patchDispatchRules } from "../src/patch.js";

test("patchDispatchRules modifies planning and execution rules correctly", async () => {
  const mockRules = [
    {
      name: "planning → plan-slice",
      match: async (ctx) => ({ action: "dispatch", prompt: "original plan prompt" }),
    },
    {
      name: "executing → reactive-execute (parallel dispatch)",
      match: async () => ({ action: "dispatch", prompt: "reactive" }),
    },
    {
      name: "executing → execute-task",
      match: async () => ({ action: "dispatch", prompt: "sequential" }),
    }
  ];

  const core = {
    "auto-dispatch": { DISPATCH_RULES: mockRules },
    "rule-registry": null,
    "gsd-db": { isDbAvailable: () => false, getTask: () => null },
    "auto-prompts": { buildReactiveExecutePrompt: async () => "prompt" },
    "preferences-models": { resolveModelWithFallbacksForUnit: () => null },
    "reactive-graph": { clearReactiveState: () => {}, saveReactiveState: () => {} },
    "state": { readState: () => null },
  };

  patchDispatchRules(core, { ui: { notify: () => {} } });

  // 1. Plan-slice should have injected WAVES.json prompt
  const planRule = mockRules.find(r => r.name.includes("plan-slice"));
  const planCtx = { mid: "M001", state: { activeSlice: { id: "S01" } }, session: { cmdCtx: {} } };
  const planRes = await planRule.match(planCtx);
  assert.ok(planRes.prompt.includes("HIGH-CONCURRENCY WAVES REQUIRED"), "plan-slice injected prompt");
  assert.ok(planRes.prompt.includes("M001"), "Milestone ID should be fully resolved in prompt");
  assert.ok(planRes.prompt.includes("S01"), "Slice ID should be fully resolved in prompt");

  // 2. Reactive-execute should be hijacked and renamed
  const reactiveRule = mockRules.find(r => r.name === "executing → explicit-reactive-waves (enforced)");
  assert.ok(reactiveRule, "reactive-execute should be hijacked and renamed");

  // 3. Sequential execute-task should now be DISABLED (renamed)
  const disabledRule = mockRules.find(r => r.name === "executing → execute-task (DISABLED BY WAVES)");
  assert.ok(disabledRule, "sequential execute-task should be disabled by waves");
  const disabledResult = await disabledRule.match({});
  assert.strictEqual(disabledResult, null, "disabled rule should always return null");
});
