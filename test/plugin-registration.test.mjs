import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

async function createMockCore(dir) {
  const gsdDir = path.join(dir, "dist", "resources", "extensions", "gsd");
  mkdirSync(gsdDir, { recursive: true });

  writeFileSync(path.join(gsdDir, "auto-dispatch.js"), `
    export const DISPATCH_RULES = [
      { name: "planning → plan-slice", match: async (args) => ({ prompt: "Original prompt" }) },
      { name: "executing → reactive-execute (parallel dispatch)", match: async () => null }
    ];
  `);
  writeFileSync(path.join(gsdDir, "gsd-db.js"), "export const isDbAvailable = () => false;\n");
  writeFileSync(path.join(gsdDir, "reactive-graph.js"), "export const clearReactiveState = () => {}; export const saveReactiveState = () => {};\n");
  writeFileSync(path.join(gsdDir, "auto-prompts.js"),
    "export const buildReactiveExecutePrompt = async () => 'Reactive prompt';\n"
  );
  writeFileSync(path.join(gsdDir, "preferences-models.js"),
    "export const resolveModelWithFallbacksForUnit = () => null;\n"
  );

  return gsdDir;
}

test("plugin-registration", async (t) => {
  let sessionStartHandler;
  let registeredCommand;

  const mockPi = {
    on: (event, handler) => {
      if (event === "session_start") sessionStartHandler = handler;
    },
    registerCommand: (name, def) => {
      registeredCommand = { name, def };
    }
  };

  await t.test("registers plugin and command", async () => {
    const mod = await import("../index.js");
    const registerPlugin = mod.default;
    registerPlugin(mockPi);
    assert.ok(sessionStartHandler, "should register session_start handler");
    assert.ok(registeredCommand, "should register /wave-size command");
    assert.strictEqual(registeredCommand.name, "wave-size");
  });

  await t.test("session_start loads core and patches", async () => {
    const tmpDir = path.join(process.cwd(), ".test-tmp-ext");
    const cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    cleanup();

    try {
      const gsdDir = await createMockCore(tmpDir);
      const oldVal = process.env.GSD_CODING_AGENT_DIR;
      process.env.GSD_CODING_AGENT_DIR = tmpDir;

      const mod = await import("../index.js");
      const registerPlugin = mod.default;
      const notifications = [];
      const mockCtx = { ui: { notify: (msg, type) => notifications.push({ msg, type }) } };

      registerPlugin(mockPi);
      await sessionStartHandler({}, mockCtx);

      const autoDispatch = await import(path.join(gsdDir, "auto-dispatch.js"));
      const rules = autoDispatch.DISPATCH_RULES;

      const enforceRule = rules.find(r => r.name === "executing → enforce-explicit-waves");
      const reactiveRule = rules.find(r => r.name === "executing → explicit-reactive-execute (true parallel dispatch)");
      assert.ok(enforceRule, "should inject enforce-explicit-waves rule");
      assert.ok(reactiveRule, "should inject explicit-reactive-execute rule");

      if (oldVal === undefined) delete process.env.GSD_CODING_AGENT_DIR;
      else process.env.GSD_CODING_AGENT_DIR = oldVal;
    } finally {
      cleanup();
    }
  });
});
