import path from "node:path";
import { readFile, writeFile } from "./util.js";

function settingsPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || "", ".gsd", "explicit-reactive.json");
}

const DEFAULT_WAVE_SIZE = 8;

export function loadWaveSize() {
  try {
    const data = JSON.parse(readFile(settingsPath()) || "{}");
    return typeof data.waveSize === "number" ? data.waveSize : DEFAULT_WAVE_SIZE;
  } catch {
    return DEFAULT_WAVE_SIZE;
  }
}

export function saveWaveSize(size) {
  writeFile(settingsPath(), JSON.stringify({ waveSize: size }));
}
