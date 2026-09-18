/**
 * nas_addon.py の純粋関数 (マスク・resolved contract validation) と
 * vendored graphql-core の結線を python3 で実行するテストラッパー。
 * mitmproxy 本体は不要 (testdata/mitmproxy_stub を PYTHONPATH に置く)。
 * python3 不在のホスト、または vendored 依存が未生成の checkout では
 * skip する。
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

// nas_addon.py は ./vendor を sys.path に足して graphql を import する。
// vendor/ は gitignore 済みの生成物なので、`bun run vendor` 未実行の
// checkout では python 側が ModuleNotFoundError で落ちる。
const vendoredDeps = existsSync(path.join(addonDir, "vendor", "graphql"));

async function runPythonUnittest(script: string): Promise<void> {
  const proc = Bun.spawn([python3 as string, script, "-v"], {
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
}

test.skipIf(!python3 || !vendoredDeps)(
  "nas_addon helpers and resolved contract (python unittest)",
  async () => {
    await runPythonUnittest("nas_addon_mask_test.py");
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "nas_addon vendored graphql-core (python unittest)",
  async () => {
    await runPythonUnittest("nas_addon_graphql_test.py");
  },
);
