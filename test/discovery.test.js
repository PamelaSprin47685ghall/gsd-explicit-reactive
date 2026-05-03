import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseBundledExtensionDirs } from "../src/discovery.js";

describe("bundled extension discovery", () => {
  it("normalizes bundled gsd index entries and deduplicates directories", () => {
    const gsdDir = path.resolve("/tmp/pi/dist/resources/extensions/gsd");
    const entries = [
      gsdDir,
      path.join(gsdDir, "index.js"),
      path.join(gsdDir, "index.ts"),
      path.resolve("/tmp/not-gsd/index.js"),
    ].join(";");

    assert.deepEqual(parseBundledExtensionDirs(entries, ";"), [gsdDir]);
  });

  it("uses the caller supplied path delimiter instead of hard-coded separators", () => {
    const firstGsdDir = path.resolve("/tmp/first/extensions/gsd");
    const secondGsdDir = path.resolve("/tmp/second/extensions/gsd");

    assert.deepEqual(
      parseBundledExtensionDirs(`${firstGsdDir};${secondGsdDir}`, ";"),
      [firstGsdDir, secondGsdDir],
    );
  });
});
