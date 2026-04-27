import fs from "node:fs";
import path from "node:path";

export function readFile(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }
}

export function writeFile(p, data) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, data);
  } catch {}
}
