import fs from "node:fs";
import path from "node:path";

const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function getTaskIds(basePath, mid, sid) {
  const dir = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith("-PLAN.md"))
    .map(f => f.replace("-PLAN.md", ""))
    .sort(TASK_COLLATOR.compare);
}

export function loadWaves(basePath, mid, sid, allTaskIds) {
  const waveFile = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "WAVES.json");
  if (!fs.existsSync(waveFile))
    return { ok: false, reason: "WAVES.json is missing" };

  let waves;
  try {
    let raw = fs.readFileSync(waveFile, "utf-8").trim();
    // Robustness: strip markdown code fences LLMs often add (```json ... ```)
    raw = raw.replace(/^```[a-zA-Z]*\n?/i, "").replace(/```$/i, "").trim();
    waves = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "WAVES.json contains malformed JSON or markdown artifacts." };
  }

  // Robustness: coerce string numbers ("1" → 1) so LLM string output doesn't break parsing
  for (const key of Object.keys(waves)) {
    if (typeof waves[key] === "string" && /^\d+$/.test(waves[key])) {
      waves[key] = parseInt(waves[key], 10);
    }
  }

  const definedTasks = new Set(Object.keys(waves));
  const missing = allTaskIds.filter(id => !definedTasks.has(id));
  const unknown = Object.keys(waves).filter(id => !allTaskIds.includes(id));

  if (missing.length > 0 || unknown.length > 0) {
    const detail = [];
    if (missing.length > 0) detail.push(`Missing: ${missing.join(",")}`);
    if (unknown.length > 0) detail.push(`Unknown: ${unknown.join(",")}`);
    return { ok: false, reason: `Task mismatch. ${detail.join(". ")}` };
  }

  for (const id of allTaskIds) {
    if (typeof waves[id] !== "number" || !Number.isInteger(waves[id]) || waves[id] < 1)
      return { ok: false, reason: `Task ${id} has invalid wave number. Must be a positive integer.` };
  }

  return { ok: true, waves };
}
