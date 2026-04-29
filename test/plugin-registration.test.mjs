import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { loadGsdCoreModules } from "../src/discovery.js";
import { patchDispatchRules } from "../src/patch.js";

async function createMockCore(dir) {
  const gsdDir = path.join(dir, "dist", "resources", "extensions", "gsd");
  mkdirSync(gsdDir, { recursive: true });

  // All REQUIRED_MODULES needed by discovery.js tryImport
  writeFileSync(path.join(gsdDir, "auto-dispatch.js"), `
export const DISPATCH_RULES = [
  { name: "planning → plan-slice", match: async (args) => ({ action: "dispatch", prompt: "Original prompt" }) },
  { name: "executing → reactive-execute (parallel dispatch)", match: async () => null }
];
`);
  writeFileSync(path.join(gsdDir, "gsd-db.js"), "export const isDbAvailable = () => false; export function getTask() { return null; };\n");
  writeFileSync(path.join(gsdDir, "reactive-graph.js"), "export const clearReactiveState = () => {}; export const saveReactiveState = () => {};\n");
  writeFileSync(path.join(gsdDir, "auto-prompts.js"),
    "export const buildReactiveExecutePrompt = async () => 'Reactive prompt';\n"
  );
  writeFileSync(path.join(gsdDir, "rule-registry.js"), "export function getRegistry() { return null; };\n");
  writeFileSync(path.join(gsdDir, "state.js"), "export const readState = () => null;\n");
  writeFileSync(path.join(gsdDir, "preferences-models.js"),
    "export const resolveModelWithFallbacksForUnit = () => null;\n"
  );

  return gsdDir;
}

test("plugin-registration", async (t) => {
  await t.test("registers plugin and command", async () => {
    let sessionStartHandler;
    const registeredCommands = [];

    const mockPi = {
      on: (event, handler) => {
        if (event === "session_start") sessionStartHandler = handler;
      },
      registerCommand: (name, def) => {
        registeredCommands.push({ name, def });
      }
    };

    const mod = await import("../index.js");
    const registerPlugin = mod.default;
    await registerPlugin(mockPi);
    assert.ok(sessionStartHandler, "should register session_start handler");
    assert.strictEqual(registeredCommands.length, 2, "should register two commands");
    assert.ok(registeredCommands.find(c => c.name === "wave-size"), "should register /wave-size command");
    assert.ok(registeredCommands.find(c => c.name === "wave-status"), "should register /wave-status command");
  });

  await t.test("loadGsdCoreModules + patchDispatchRules patches mock rules correctly", async () => {
    const tmpDir = path.join(process.cwd(), ".test-tmp-ext");
    const cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    cleanup();

    let oldVal;
    try {
      await createMockCore(tmpDir);
      oldVal = process.env.GSD_CODING_AGENT_DIR;
      process.env.GSD_CODING_AGENT_DIR = tmpDir;

      // Load core modules from mock dir
      const core = await loadGsdCoreModules({ ui: { notify: () => {} } });
      assert.ok(core, "should load core modules from mock dir");
      assert.ok(core["auto-dispatch"], "should have auto-dispatch module");

      // Patch the rules
      patchDispatchRules(core, { ui: { notify: () => {} } });

      // Check that plan-slice was injected with WAVES.json prompt
      const planRule = core["auto-dispatch"].DISPATCH_RULES.find(r => r.name.includes("plan-slice"));
      assert.ok(planRule._wavesPatched, "plan-slice should be patched");

      // Check that reactive-execute was hijacked and renamed
      const hijackedRule = core["auto-dispatch"].DISPATCH_RULES.find(
        r => r.name === "executing → explicit-reactive-waves (enforced)"
      );
      assert.ok(hijackedRule, "should replace reactive-execute with explicit-reactive-waves");

      // Check that plan-slice prompt was injected
      const planRes = await planRule.match({ mid: "M01", state: { activeSlice: { id: "S01" } } });
      assert.ok(planRes.prompt.includes("HIGH-CONCURRENCY WAVES REQUIRED"),
        "plan-slice prompt should include WAVES.json injection");
    } finally {
      if (oldVal === undefined) delete process.env.GSD_CODING_AGENT_DIR;
      else process.env.GSD_CODING_AGENT_DIR = oldVal;
      cleanup();
    }
  });
});
