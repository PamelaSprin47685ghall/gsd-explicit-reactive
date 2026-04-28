import fs from "node:fs";
import path from "node:path";

export function readFile(p, ctx) {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  } catch (err) {
    ctx?.ui?.notify(`Failed to read ${p}: ${err.message}`, "warning");
    return "";
  }
}

export function writeFile(p, data, ctx) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, data);
  } catch (err) {
    ctx?.ui?.notify(`Failed to write ${p}: ${err.message}`, "error");
    throw err;
  }
}
