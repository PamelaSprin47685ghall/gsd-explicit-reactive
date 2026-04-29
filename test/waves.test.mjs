import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { getTaskIds, loadWaves } from "../src/waves.js";
import { withTmp, makeTaskPlan, makeWaves } from "./helpers.mjs";

// Mock ctx for loadWaves
const mockCtx = { ui: { notify: () => {} } };

test("waves", async (t) => {
  await t.test("getTaskIds returns sorted task IDs", () => {
    withTmp(tmp => {
      const tasksDir = path.join(tmp, ".gsd", "milestones", "M01", "slices", "S01", "tasks");
      makeTaskPlan(tasksDir, "T03", "T01", "T02");
      const ids = getTaskIds(tmp, "M01", "S01");
      assert.deepStrictEqual(ids, ["T01", "T02", "T03"]);
    });
  });

  await t.test("getTaskIds returns empty array when no tasks dir", () => {
    withTmp(tmp => {
      assert.deepStrictEqual(getTaskIds(tmp, "M01", "S01"), []);
    });
  });

  await t.test("loadWaves returns ok with valid JSON", () => {
    withTmp(tmp => {
      const slicesDir = path.join(tmp, ".gsd", "milestones", "M01", "slices", "S01");
      makeTaskPlan(path.join(slicesDir, "tasks"), "T01", "T02", "T03");
      makeWaves(slicesDir, { T01: 1, T02: 1, T03: 2 });
      const result = loadWaves(mockCtx, tmp, "M01", "S01", ["T01", "T02", "T03"]);
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.waves, { T01: 1, T02: 1, T03: 2 });
    });
  });

  await t.test("loadWaves returns reason when file missing", () => {
    withTmp(tmp => {
      const result = loadWaves(mockCtx, tmp, "M01", "S01", []);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes("missing"));
    });
  });

  await t.test("loadWaves catches task mismatch", () => {
    withTmp(tmp => {
      const slicesDir = path.join(tmp, ".gsd", "milestones", "M01", "slices", "S01");
      makeTaskPlan(path.join(slicesDir, "tasks"), "T01", "T02");
      makeWaves(slicesDir, { T01: 1, T99: 1 });
      const result = loadWaves(mockCtx, tmp, "M01", "S01", ["T01", "T02"]);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes("Missing") && result.reason.includes("Unknown"));
    });
  });

  await t.test("loadWaves rejects non-positive wave numbers", () => {
    withTmp(tmp => {
      const slicesDir = path.join(tmp, ".gsd", "milestones", "M01", "slices", "S01");
      makeTaskPlan(path.join(slicesDir, "tasks"), "T01");
      makeWaves(slicesDir, { T01: 0 });
      const result = loadWaves(mockCtx, tmp, "M01", "S01", ["T01"]);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes("invalid wave"));
    });
  });

  await t.test("loadWaves returns reason on raw malformed JSON", () => {
    withTmp(tmp => {
      const slicesDir = path.join(tmp, ".gsd", "milestones", "M01", "slices", "S01");
      fs.mkdirSync(slicesDir, { recursive: true });
      fs.writeFileSync(path.join(slicesDir, "WAVES.json"), "{BAD");
      const result = loadWaves(mockCtx, tmp, "M01", "S01", []);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes("malformed"));
    });
  });
});
