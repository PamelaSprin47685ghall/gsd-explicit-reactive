import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert";

test('gsd-explicit-reactive', async (t) => {
  const testDir = path.join(process.cwd(), "test-core", "extensions", "gsd");
  fs.mkdirSync(testDir, { recursive: true });
  
  fs.writeFileSync(path.join(testDir, "gsd-db.js"), "export const isDbAvailable = () => false;\n");
  fs.writeFileSync(path.join(testDir, "reactive-graph.js"), "export const clearReactiveState = () => {};\n");
  fs.writeFileSync(path.join(testDir, "auto-prompts.js"), "export const buildReactiveExecutePrompt = async () => 'Reactive prompt';\n");
  fs.writeFileSync(path.join(testDir, "preferences-models.js"), "export const resolveModelWithFallbacksForUnit = () => null;\n");
  fs.writeFileSync(path.join(testDir, "auto-dispatch.js"), `
    export const DISPATCH_RULES = [
      { name: "planning → plan-slice", match: async (args) => ({ prompt: "Original prompt" }) },
      { name: "executing → reactive-execute (parallel dispatch)", match: async () => null }
    ];
  `);
  
  process.env.GSD_CODING_AGENT_DIR = path.join(process.cwd(), "test-core");
  
  const registerPlugin = (await import("./index.js")).default;
  
  const notifications = [];
  const mockCtx = { ui: { notify: (msg, type) => { notifications.push({ msg, type }); } } };
  let sessionStartHandler;
  
  const mockPi = { 
    on: (event, handler) => { if (event === "session_start") sessionStartHandler = handler; },
    registerCommand: () => {} 
  };
  
  // Call the sync default export
  registerPlugin(mockPi);
  
  // Now trigger session_start (async, so await it)
  await sessionStartHandler({}, mockCtx);
  
  const autoDispatch = await import(path.join(testDir, "auto-dispatch.js"));
  const rules = autoDispatch.DISPATCH_RULES;
  
  await t.test('injects WAVES.json prompt into plan-slice', async () => {
    const planRule = rules.find(r => r.name === "planning → plan-slice");
    const result = await planRule.match({ mid: "M01", state: { activeSlice: { id: "S01" } } });
    assert.ok(result.prompt.includes('WAVES.json'), "should inject WAVES.json requirements");
  });

  await t.test('replaces reactive-execute with explicit rules', () => {
    const enforceRule = rules.find(r => r.name === "executing → enforce-explicit-waves");
    const reactiveRule = rules.find(r => r.name === "executing → explicit-reactive-execute (parallel dispatch)");
    assert.ok(enforceRule, "should inject enforce rule");
    assert.ok(reactiveRule, "should inject reactive rule");
  });
  
  await t.test('enforce-explicit-waves returns repair prompt if WAVES.json missing', async () => {
    const enforceRule = rules.find(r => r.name === "executing → enforce-explicit-waves");
    const result = await enforceRule.match({ 
      state: { phase: "executing", activeSlice: { id: "S01" } }, 
      mid: "M01", 
      basePath: process.cwd() 
    });
    
    assert.strictEqual(result.unitType, "plan-slice", "should return plan-slice unit to force repair");
    assert.ok(result.prompt.includes('WAVES.json is missing'), "should mention missing reason");
  });
});
