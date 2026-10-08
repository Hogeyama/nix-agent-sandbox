import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

test("README entrypoint runs the main command without ready, even if serve fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dind-entry-"));
  try {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    const section = readme.split(
      "### `.devcontainer/dind-bridge-entrypoint.sh`",
    )[1];
    const script = /```sh\n([\s\S]*?)```/.exec(section)?.[1];
    assert.ok(script, "README entrypoint example missing");
    const entry = join(directory, "entrypoint.sh");
    await writeFile(entry, script.replaceAll("/run/dind-bridge", directory));
    // The real /proc and dockerd are unnecessary: serve deliberately cannot
    // finish until the main command starts, and never prints ready at all.
    await writeFile(
      join(directory, "readlink"),
      "#!/bin/sh\necho 'net:[42]'\n",
    );
    await writeFile(
      join(directory, "dind-bridge"),
      '#!/bin/sh\nwhile [ ! -f "$STATE/main-started" ]; do sleep 0.01; done\necho failed > "$STATE/serve-ended"\nexit 1\n',
    );
    await chmod(join(directory, "readlink"), 0o755);
    await chmod(join(directory, "dind-bridge"), 0o755);
    const result = await promisify(execFile)(
      "sh",
      [entry, "sh", "-c", 'touch "$STATE/main-started"; echo main-running'],
      {
        timeout: 2000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          STATE: directory,
        },
      },
    );
    assert.equal(result.stdout, "main-running\n");
    let ended = "";
    for (let i = 0; !ended && i < 100; i++) {
      ended = await readFile(join(directory, "serve-ended"), "utf8").catch(
        () => "",
      );
      if (!ended) await delay(10);
    }
    assert.equal(ended, "failed\n");
  } finally {
    // Also release a failed test's stand-in before removing its directory.
    await writeFile(join(directory, "main-started"), "");
    await delay(30);
    await rm(directory, { recursive: true, force: true });
  }
});
