import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateExplicitDeps,
  computeReadySet,
  calculateDagMetrics,
} from "../src/deps.js";

describe("validateExplicitDeps", () => {
  it("should reject when deps.tasks is an array", () => {
    const deps = { version: 1, tasks: [] };
    const sliceTasks = [{ id: "T01" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("must be a plain object")));
  });

  it("should reject unsupported version", () => {
    const deps = { version: 2, tasks: {} };
    const sliceTasks = [];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("Unsupported DEPS version")));
  });

  it("should reject missing task in DEPS", () => {
    const deps = { version: 1, tasks: {} };
    const sliceTasks = [{ id: "T01" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("Missing task in DEPS.tasks: T01")));
  });

  it("should reject unknown task in DEPS", () => {
    const deps = { version: 1, tasks: { T99: { depends_on: [] } } };
    const sliceTasks = [{ id: "T01" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("Unknown task declared in DEPS: T99")));
  });

  it("should reject non-array depends_on", () => {
    const deps = { version: 1, tasks: { T01: { depends_on: "T02" } } };
    const sliceTasks = [{ id: "T01" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("depends_on must be an array")));
  });

  it("should reject non-string dependency (Bug #16)", () => {
    const deps = { version: 1, tasks: { T01: { depends_on: [123, null] } } };
    const sliceTasks = [{ id: "T01" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("must contain only strings")));
  });

  it("should reject duplicate dependencies (Bug #21)", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01", "T01"] },
      },
    };
    const sliceTasks = [{ id: "T01" }, { id: "T02" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("duplicate dependency T01")));
  });

  it("should reject unknown dependency", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T99"] },
      },
    };
    const sliceTasks = [{ id: "T01" }, { id: "T02" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("depends on unknown task: T99")));
  });

  it("should reject self-dependency", () => {
    const deps = {
      version: 1,
      tasks: { T01: { depends_on: ["T01"] } },
    };
    const sliceTasks = [{ id: "T01" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("self-dependency")));
  });

  it("should reject cycles", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: ["T02"] },
        T02: { depends_on: ["T01"] },
      },
    };
    const sliceTasks = [{ id: "T01" }, { id: "T02" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("Cycle detected")));
  });

  it("should accept valid DEPS", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
      },
    };
    const sliceTasks = [{ id: "T01" }, { id: "T02" }];
    const result = validateExplicitDeps(deps, sliceTasks);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors.length, 0);
  });
});

