import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const withTmp = (fn) => {
  const d = mkdtempSync(join(tmpdir(), "gsd-"));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};

export function withEnv(k, v, fn) {
  const o = process.env[k];
  v === undefined ? delete process.env[k] : process.env[k] = v;
  try { return fn(); } finally { o === undefined ? delete process.env[k] : process.env[k] = o; }
}

export function makeTaskPlan(dir, ...taskIds) {
  mkdirSync(dir, { recursive: true });
  for (const id of taskIds)
    writeFileSync(join(dir, `${id}-PLAN.md`), `# ${id} Plan\n`);
}

export function makeWaves(dir, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "WAVES.json"), JSON.stringify(data));
}
