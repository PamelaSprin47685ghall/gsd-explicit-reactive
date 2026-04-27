import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { loadWaveSize, saveWaveSize } from "../src/settings.js";
import { withTmp, withEnv } from "./helpers.mjs";

test("settings", async (t) => {
  await t.test("defaults to 8 when no settings file exists", () => {
    withTmp(tmp => {
      withEnv("HOME", tmp, () => {
        assert.strictEqual(loadWaveSize(), 8);
      });
    });
  });

  await t.test("persists and retrieves wave size", () => {
    withTmp(tmp => {
      withEnv("HOME", tmp, () => {
        saveWaveSize(5);
        assert.strictEqual(loadWaveSize(), 5);
      });
    });
  });

  await t.test("returns default on malformed JSON", () => {
    withTmp(tmp => {
      withEnv("HOME", tmp, () => {
        const dir = path.join(tmp, ".gsd");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(tmp, ".gsd", "explicit-reactive.json"), "not-json");
        assert.strictEqual(loadWaveSize(), 8);
      });
    });
  });
});
