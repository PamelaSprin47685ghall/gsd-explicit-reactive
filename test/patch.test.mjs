import test from "node:test";
import assert from "node:assert/strict";
import { patchDispatchRules } from "../src/patch.js";

test("patchDispatchRules modifies planning and execution rules correctly", async () => {
  // Mock GSD-2 Rules
  const mockRules = [
    {
      name: "planning → plan-slice",
      where: async () => ({ action: "dispatch", prompt: "original plan prompt" }),
    },
    {
      name: "refining → refine-slice",
      where: async () => ({ action: "dispatch", prompt: "original refine prompt" }),
    },
    {
      name: "executing → reactive-execute (parallel dispatch)",
      where: async () => ({ action: "dispatch", prompt: "reactive" }),
    },
    {
      name: "executing → execute-task (recover missing task plan → plan-slice)",
      where: async () => ({ action: "dispatch", prompt: "recover" }),
    },
    {
      name: "executing → execute-task",
      where: async () => ({ action: "dispatch", prompt: "sequential" }),
    }
  ];

  const core = {
    "auto-dispatch": { DISPATCH_RULES: mockRules },
    "rule-registry": null,
  };

  const capturedCtx = {
    ui: { notify: () => {} }
  };

  // Run the patch
  patchDispatchRules(core, {}, capturedCtx);

  // 1. Assert planning and refining rules received prompt injection
  const planRule = mockRules.find(r => r.name.includes("plan-slice"));
  const planRes = await planRule.where();
  assert.ok(planRes.prompt.includes("CRITICAL: AGGRESSIVE FINE-GRAINED PARALLELISM"), "plan-slice should have injected prompt");

  const refineRule = mockRules.find(r => r.name.includes("refine-slice"));
  const refineRes = await refineRule.where();
  assert.ok(refineRes.prompt.includes("CRITICAL: AGGRESSIVE FINE-GRAINED PARALLELISM"), "refine-slice should have injected prompt");

  // 2. Assert reactive-execute is hijacked and renamed correctly
  const reactiveRule = mockRules.find(r => r.name === "executing → explicit-reactive-waves (enforced)");
  assert.ok(reactiveRule, "reactive-execute rule should be hijacked and renamed");

  // 3. Assert sequential execute-task rules are completely untouched
  const sequentialRule = mockRules.find(r => r.name === "executing → execute-task");
  assert.ok(sequentialRule, "normal execute-task rule MUST be preserved intact");

  const recoveryRule = mockRules.find(r => r.name.includes("recover"));
  assert.ok(recoveryRule, "execute-task recovery rule MUST be preserved intact");
});
