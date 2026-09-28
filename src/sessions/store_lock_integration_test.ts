import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applySessionHook,
  createSession,
  ensureSessionRuntimePaths,
  readSession,
} from "./store.ts";

const flockAvailable = Bun.which("flock") !== null;

test.skipIf(!flockAvailable)(
  "concurrent hook processes claim one notification and retain concurrent UI metadata updates",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nas-hook-concurrent-"));
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    try {
      const paths = await ensureSessionRuntimePaths(`${dir}/sessions`);
      await createSession(paths, {
        sessionId: "session",
        agent: "codex",
        profile: "default",
        startedAt: new Date().toISOString(),
      });
      await applySessionHook(paths, "session", "start");
      const script = `${dir}/hook.ts`;
      await writeFile(
        script,
        `import { applySessionHook, updateSessionName } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const paths = ${JSON.stringify(paths)};
if (process.argv[2] === "name") await updateSessionName(paths, "session", "Renamed");
else console.log((await applySessionHook(paths, "session", "attention")).notify);
`,
      );
      for (let i = 0; i < 9; i++)
        children.push(
          Bun.spawn(
            [process.execPath, script, i === 8 ? "name" : "attention"],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          ),
        );
      const results = await Promise.all(
        children.map(async (child) => {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code, stderr).toBe(0);
          return stdout.trim();
        }),
      );
      expect(results.filter((value) => value === "true")).toHaveLength(1);
      expect(await readSession(paths, "session")).toMatchObject({
        turn: "user-turn",
        name: "Renamed",
      });
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
