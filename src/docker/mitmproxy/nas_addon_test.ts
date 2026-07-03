/**
 * nas_addon.py のマスク純粋関数を python3 で実行するテストラッパー。
 * mitmproxy 本体は不要 (testdata/mitmproxy_stub を PYTHONPATH に置く)。
 * python3 不在のホストでは skip する。
 */

import { expect, test } from "bun:test";
import * as path from "node:path";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

test.skipIf(!python3)("nas_addon mask helpers (python unittest)", async () => {
  const proc = Bun.spawn([python3 as string, "nas_addon_mask_test.py", "-v"], {
    cwd: addonDir,
    env: {
      ...process.env,
      PYTHONPATH: path.join(addonDir, "testdata", "mitmproxy_stub"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
  }
  expect(exitCode).toEqual(0);
});
