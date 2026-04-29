import test from "node:test";
import assert from "node:assert/strict";
import { patchDispatchRules } from "../src/patch.js";

test("patchDispatchRules modifies planning and execution rules correctly", async () => {
  const mockRules = [
    {
      name: "planning → plan-slice",
      match: async () => ({ action: "dispatch", prompt: "original plan prompt" }),
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
  };

  patchDispatchRules(core, {});

  const planRule = mockRules.find(r => r.name.includes("plan-slice"));
  const planCtx = { mid: "M001", state: { activeSlice: { id: "S01" } }, session: {} };
  const planRes = await planRule.match(planCtx);

  assert.ok(planRes.prompt.includes("CRITICAL: AGGRESSIVE FINE-GRAINED PARALLELISM"), "plan-slice injected prompt");
  assert.ok(planRes.prompt.includes("M001"), "Milestone ID should be fully resolved in prompt");
  assert.ok(planRes.prompt.includes("S01"), "Slice ID should be fully resolved in prompt");

  const reactiveRule = mockRules.find(r => r.name === "executing → explicit-reactive-waves (enforced)");
  assert.ok(reactiveRule, "reactive-execute hijacked");

  const sequentialRule = mockRules.find(r => r.name === "executing → execute-task");
  assert.ok(sequentialRule, "normal execute-task rule MUST be preserved intact");
});
