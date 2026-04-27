import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const REQUIRED_MODULES = ["auto-dispatch", "gsd-db", "auto-prompts", "reactive-graph"];

async function tryImport(dir) {
  if (!fs.existsSync(dir)) return null;
  let allFound = true;
  for (const mod of REQUIRED_MODULES) {
    if (!fs.existsSync(path.join(dir, `${mod}.js`))) { allFound = false; break; }
  }
  if (!allFound) return null;
  const loaded = {};
  for (const mod of REQUIRED_MODULES)
    loaded[mod] = await import(pathToFileURL(path.join(dir, `${mod}.js`)).href);
  return loaded;
}

export async function loadGsdCoreModules(ctx) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];

  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("@gsd/pi-coding-agent/package.json");
    candidates.push(path.join(path.dirname(pkgPath), "dist", "resources", "extensions", "gsd"));
  } catch {}

  if (process.env.GSD_CODING_AGENT_DIR)
    candidates.push(path.join(process.env.GSD_CODING_AGENT_DIR, "extensions", "gsd"));
  if (process.env.GSD_PKG_ROOT) {
    candidates.push(path.join(process.env.GSD_PKG_ROOT, "dist", "resources", "extensions", "gsd"));
    candidates.push(path.join(process.env.GSD_PKG_ROOT, "src", "resources", "extensions", "gsd"));
  }

  candidates.push(
    path.join(extensionDir, "..", "gsd", "dist", "resources", "extensions", "gsd"),
    path.join(extensionDir, "..", "gsd", "src", "resources", "extensions", "gsd"),
    path.join(extensionDir, "..", "gsd-2", "dist", "resources", "extensions", "gsd"),
    path.join(extensionDir, "..", "gsd-2", "src", "resources", "extensions", "gsd"),
    path.join(process.cwd(), "gsd-2", "dist", "resources", "extensions", "gsd"),
    path.join(process.cwd(), "gsd-2", "src", "resources", "extensions", "gsd"),
  );

  for (const dir of candidates) {
    const mod = await tryImport(dir);
    if (mod) return mod;
  }

  ctx?.ui?.notify("Missing @gsd/pi-coding-agent — explicit-reactive dispatch disabled.", "error");
  return null;
}
