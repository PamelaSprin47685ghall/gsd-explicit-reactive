import path from "node:path";
import { readFile, writeFile } from "./util.js";

function settingsPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || "", ".gsd", "explicit-reactive.json");
}

const DEFAULT_WAVE_SIZE = 8;

export function loadWaveSize(ctx) {
  try {
    const data = JSON.parse(readFile(settingsPath(), ctx) || "{}");
    return typeof data.waveSize === "number" ? data.waveSize : DEFAULT_WAVE_SIZE;
  } catch (err) {
    ctx?.ui?.notify(`Failed to load wave-size: ${err.message}`, "warning");
    return DEFAULT_WAVE_SIZE;
  }
}

export function saveWaveSize(size, ctx) {
  try {
    writeFile(settingsPath(), JSON.stringify({ waveSize: size }), ctx);
    return true;
  } catch (err) {
    ctx?.ui?.notify(`Failed to save wave-size: ${err.message}`, "error");
    return false;
  }
}
