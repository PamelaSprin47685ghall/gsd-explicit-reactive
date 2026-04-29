import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CORE_MODULES = [
  "auto-dispatch", "gsd-db", "auto-prompts", "reactive-graph"
];

export async function loadGsdCore() {
  const candidates = [];

  if (process.env.GSD_CODING_AGENT_DIR) {
    candidates.push(path.join(process.env.GSD_CODING_AGENT_DIR, "dist", "resources", "extensions", "gsd"));
  }
  if (process.env.GSD_PKG_ROOT) {
    candidates.push(path.join(process.env.GSD_PKG_ROOT, "dist", "resources", "extensions", "gsd"));
  }
  candidates.push(path.resolve(process.cwd(), "node_modules/@gsd/pi-coding-agent/dist/resources/extensions/gsd"));

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;

    const isComplete = CORE_MODULES.every(mod => fs.existsSync(path.join(dir, `${mod}.js`)));
    if (!isComplete) continue;

    const loaded = {};
    for (const mod of CORE_MODULES) {
      const modPath = pathToFileURL(path.join(dir, `${mod}.js`)).href;
      loaded[mod] = await import(modPath);
    }
    return loaded;
  }

  return null;
}
