import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundledDataDir = path.join(__dirname, "..", "data");

// All mutable runtime state (the SQLite DB, filter/settings JSON files) lives
// here. Locally this is just <repo>/data. On Railway, RAILWAY_VOLUME_MOUNT_PATH
// points at an attached persistent Volume instead — without this, every
// redeploy would wipe trade history and any filter/settings changes made
// live via Telegram, since the container filesystem itself isn't persistent.
export function getDataDir() {
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH || bundledDataDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A fresh Railway Volume starts empty. Most settings files self-seed with
// hardcoded defaults on first read, but filters.json holds real tuned values
// (backtested thresholds, not placeholder defaults) with no such fallback —
// so on first boot against an empty volume, copy the bundled, git-tracked
// version in as the starting point instead of crashing or reinventing
// generic values.
export function seedFileIfMissing(filename) {
  const dataDir = getDataDir();
  if (dataDir === bundledDataDir) return; // local dev — nothing to seed, it's the same file
  const dest = path.join(dataDir, filename);
  const src = path.join(bundledDataDir, filename);
  if (!fs.existsSync(dest) && fs.existsSync(src)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
