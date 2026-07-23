import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const shimDir = path.join(root, "node_modules", "openclaw");
const pkgPath = path.join(shimDir, "package.json");
const entryPath = path.join(shimDir, "plugin-entry.js");

if (!fs.existsSync(pkgPath)) {
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(pkgPath, JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/plugin-entry": "./plugin-entry.js" } }) + "\n");
  fs.writeFileSync(entryPath, "export function definePluginEntry(def) { return def; }\n");
}
