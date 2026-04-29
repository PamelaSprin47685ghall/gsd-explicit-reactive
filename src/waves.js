import fs from "node:fs";
import path from "node:path";
import { uiLog } from "./logger.js";

const TASK_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function getTaskIds(basePath, mid, sid, dbModule) {
  if (dbModule && typeof dbModule.getSliceTasks === "function") {
    const tasks = dbModule.getSliceTasks(mid, sid);
    if (tasks && tasks.length > 0) {
      return tasks.map(t => t.id).sort(TASK_COLLATOR.compare);
    }
  }
  const dir = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith("-PLAN.md"))
    .map(f => f.replace("-PLAN.md", ""))
    .sort(TASK_COLLATOR.compare);
}

export function loadWaves(ctx, basePath, mid, sid, allTaskIds) {
  const waveFile = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "WAVES.json");
  if (!fs.existsSync(waveFile)) {
    uiLog(ctx, `WAVES.json 丢失! 路径: ${waveFile}`, "error");
    return { ok: false, reason: "WAVES.json is missing. You MUST generate it." };
  }

  let waves;
  try {
    let raw = fs.readFileSync(waveFile, "utf-8").trim();
    raw = raw.replace(/^```[a-zA-Z]*\n?/i, "").replace(/```$/i, "").trim();
    waves = JSON.parse(raw);
  } catch (e) {
    uiLog(ctx, "WAVES.json 解析失败，存在语法错误或包含 Markdown 标记。", "error");
    return { ok: false, reason: "WAVES.json contains malformed JSON or markdown artifacts." };
  }

  const normalizedWaves = {};
  for (const key of Object.keys(waves)) {
    const normKey = key.toUpperCase();
    let val = waves[key];
    if (typeof val === "string" && /^\d+$/.test(val)) val = parseInt(val, 10);
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
      return { ok: false, reason: `Task ${normKey} has an invalid wave number. Must be a positive integer >= 1.` };
    }
    normalizedWaves[normKey] = val;
  }

  const definedTasks = new Set(Object.keys(normalizedWaves));
  const missing = allTaskIds.filter(id => !definedTasks.has(id));
  const unknown = Object.keys(normalizedWaves).filter(id => !allTaskIds.includes(id));

  if (missing.length > 0 || unknown.length > 0) {
    const detail = [];
    if (missing.length > 0) detail.push(`Missing: ${missing.join(", ")}`);
    if (unknown.length > 0) detail.push(`Unknown: ${unknown.join(", ")}`);
    uiLog(ctx, `任务数量不匹配! ${detail.join("; ")}`, "error");
    return { ok: false, reason: `Task mismatch between PLAN and WAVES.json. ${detail.join("; ")}` };
  }

  uiLog(ctx, "WAVES.json 校验通过", "success");
  return { ok: true, waves: normalizedWaves };
}
