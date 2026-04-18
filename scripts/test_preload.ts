/**
 * Test preload — isolates XDG state written by `bun test`.
 *
 * Without this, tests that exercise code reading the default
 * `$XDG_RUNTIME_DIR/nas/sessions/`, `$XDG_STATE_HOME/nas/…`,
 * `$XDG_DATA_HOME/nas/audit/`, `$XDG_CACHE_HOME/nas/ui/`, or
 * `$XDG_CONFIG_HOME/nas/…` paths would read and write the real
 * user's directories and pollute the UI's session list, audit log,
 * and recent-dirs MRU.
 *
 * Every `bun test` process gets a unique temp dir; it is removed on
 * exit. Individual tests that save/restore XDG_* env vars still work:
 * they capture our temp paths and restore to them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "nas-test-xdg-"));

process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_DATA_HOME = path.join(root, "data");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.NAS_SESSION_STORE_DIR = path.join(
  root,
  "runtime",
  "nas",
  "sessions",
);

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});
