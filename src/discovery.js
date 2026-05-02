import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CORE_MODULES = [
  "auto-dispatch", "gsd-db", "auto-prompts", "reactive-graph", "rule-registry"
];

const dedupe = (items) => [...new Set(items.filter(Boolean))];

const bundledExtensionDirs = () => {
  const raw = process.env.GSD_BUNDLED_EXTENSION_PATHS;
  if (!raw) return [];
  return raw
    .split(":")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      if (entry.endsWith("/gsd/index.js")) return path.dirname(entry);
      return null;
    })
    .filter(Boolean);
};

const buildCandidateDirs = () => dedupe([
  process.env.GSD_CODING_AGENT_DIR ? path.join(process.env.GSD_CODING_AGENT_DIR, "extensions", "gsd") : null,
  process.env.GSD_CODING_AGENT_DIR ? path.join(process.env.GSD_CODING_AGENT_DIR, "dist", "resources", "extensions", "gsd") : null,
  ...bundledExtensionDirs(),
  process.env.GSD_PKG_ROOT ? path.join(process.env.GSD_PKG_ROOT, "dist", "resources", "extensions", "gsd") : null,
  path.resolve(process.cwd(), "node_modules/@gsd/pi-coding-agent/dist/resources/extensions/gsd"),
]);

export async function loadGsdCore() {
  const candidates = buildCandidateDirs();

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;

    const isComplete = CORE_MODULES.every(mod => fs.existsSync(path.join(dir, `${mod}.js`)));
    if (!isComplete) continue;

    const loaded = {};
    try {
      for (const mod of CORE_MODULES) {
        const modPath = pathToFileURL(path.join(dir, `${mod}.js`)).href;
        loaded[mod] = await import(modPath);
      }
      return loaded;
    } catch (err) {
      console.error(`[DAG] Failed to load GSD core from ${dir}: ${err.message}`);
      continue;
    }
  }

  return null;
}
