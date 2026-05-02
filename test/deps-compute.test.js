import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeReadySet,
  calculateDagMetrics,
} from "../src/deps.js";

describe("computeReadySet", () => {
  it("should return empty array for empty DEPS", () => {
    const deps = { version: 1, tasks: {} };
    const allTasks = [];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready, []);
  });

  it("should return tasks with no dependencies", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: [] },
      },
    };
    const allTasks = [
      { id: "T01", status: "pending" },
      { id: "T02", status: "pending" },
    ];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready.sort(), ["T01", "T02"]);
  });

  it("should exclude completed tasks", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: [] },
      },
    };
    const allTasks = [
      { id: "T01", status: "complete" },
      { id: "T02", status: "pending" },
    ];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready, ["T02"]);
  });

  it("should return tasks whose dependencies are complete", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
      },
    };
    const allTasks = [
      { id: "T01", status: "complete" },
      { id: "T02", status: "pending" },
    ];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready, ["T02"]);
  });

  it("should not return tasks with pending dependencies", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
      },
    };
    const allTasks = [
      { id: "T01", status: "pending" },
      { id: "T02", status: "pending" },
    ];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready, ["T01"]);
  });

  it("should handle skipped tasks as done", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
      },
    };
    const allTasks = [
      { id: "T01", status: "skipped" },
      { id: "T02", status: "pending" },
    ];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready, ["T02"]);
  });

  it("should handle case-insensitive status", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
      },
    };
    const allTasks = [
      { id: "T01", status: "COMPLETE" },
      { id: "T02", status: "PENDING" },
    ];
    const ready = computeReadySet(deps, allTasks);
    assert.deepStrictEqual(ready, ["T02"]);
  });
});

describe("calculateDagMetrics", () => {
  it("should handle empty DEPS", () => {
    const deps = { version: 1, tasks: {} };
    const metrics = calculateDagMetrics(deps);
    assert.strictEqual(metrics.totalTasks, 0);
    assert.strictEqual(metrics.criticalPathLength, 0);
    assert.strictEqual(metrics.averageWidth, 0);
  });

  it("should calculate metrics for single task", () => {
    const deps = {
      version: 1,
      tasks: { T01: { depends_on: [] } },
    };
    const metrics = calculateDagMetrics(deps);
    assert.strictEqual(metrics.totalTasks, 1);
    assert.strictEqual(metrics.criticalPathLength, 1);
    assert.strictEqual(metrics.averageWidth, 1);
  });

  it("should calculate metrics for parallel tasks", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: [] },
        T03: { depends_on: [] },
      },
    };
    const metrics = calculateDagMetrics(deps);
    assert.strictEqual(metrics.totalTasks, 3);
    assert.strictEqual(metrics.criticalPathLength, 1);
    assert.strictEqual(metrics.averageWidth, 3);
  });

  it("should calculate metrics for sequential tasks", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
        T03: { depends_on: ["T02"] },
      },
    };
    const metrics = calculateDagMetrics(deps);
    assert.strictEqual(metrics.totalTasks, 3);
    assert.strictEqual(metrics.criticalPathLength, 3);
    assert.strictEqual(metrics.averageWidth, 1);
  });

  it("should detect cycles and return safe metrics (Bug #11)", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: ["T02"] },
        T02: { depends_on: ["T01"] },
      },
    };
    const metrics = calculateDagMetrics(deps);
    assert.strictEqual(metrics.totalTasks, 2);
    assert.strictEqual(metrics.criticalPathLength, 2);
    assert.strictEqual(metrics.averageWidth, 1);
  });

  it("should calculate metrics for diamond DAG", () => {
    const deps = {
      version: 1,
      tasks: {
        T01: { depends_on: [] },
        T02: { depends_on: ["T01"] },
        T03: { depends_on: ["T01"] },
        T04: { depends_on: ["T02", "T03"] },
      },
    };
    const metrics = calculateDagMetrics(deps);
    assert.strictEqual(metrics.totalTasks, 4);
    assert.strictEqual(metrics.criticalPathLength, 3);
    assert.strictEqual(metrics.averageWidth, 4 / 3);
  });
});
