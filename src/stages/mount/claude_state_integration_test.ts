import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { configureClaude } from "../../agents/claude.ts";
import {
  prepareProtectedClaudeState,
  removeProtectedClaudeState,
} from "./claude_state_fs.ts";

const bwrap = Bun.which("bwrap");
const trueCommand = Bun.which("true");
const shell = Bun.which("sh");
const canBind =
  bwrap !== null &&
  trueCommand !== null &&
  shell !== null &&
  (await Bun.spawn(
    [
      bwrap,
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      trueCommand,
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exited) === 0;

test.skipIf(!canBind)(
  "protected Claude mounts reject configuration changes, persist state, and keep new files private",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nas-claude-bind-test-"));
    let state:
      | Awaited<ReturnType<typeof prepareProtectedClaudeState>>
      | undefined;
    try {
      await mkdir(path.join(home, ".claude/plugins"), { recursive: true });
      await writeFile(path.join(home, ".claude/plugins/hook.sh"), "original");
      await writeFile(path.join(home, ".claude/settings.json"), "{}");
      state = await prepareProtectedClaudeState(home);
      const containerHome = "/tmp/nas-claude-test-home";
      const result = configureClaude({
        hostHome: home,
        containerHome,
        protectSettings: true,
        protectedClaudeState: state,
        probes: {
          claudeDirExists: true,
          claudeJsonExists: true,
          claudeBinPath: trueCommand,
          claudeSettingsFiles: ["settings.json"],
        },
        priorDockerArgs: [],
        priorEnvVars: {},
      });
      const args = [
        bwrap!,
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
      ];
      for (const mount of result.mounts ?? [])
        args.push(
          mount.readOnly ? "--ro-bind" : "--bind",
          mount.source,
          mount.target,
        );
      const script = `
set -eu
cd /tmp/nas-claude-test-home/.claude
if (printf bad > settings.json) 2>/dev/null; then exit 10; fi
if (printf bad > plugins/hook.sh) 2>/dev/null; then exit 11; fi
if rm settings.json 2>/dev/null; then exit 12; fi
printf private > future-config.json
mkdir -p shell-snapshots
printf private > shell-snapshots/session.sh
printf '{"updated":true}' > .credentials.json.tmp
# Claude's atomic writer falls back to an in-place write for a bound file.
if ! mv .credentials.json.tmp .credentials.json 2>/dev/null; then
  cat .credentials.json.tmp > .credentials.json
  rm .credentials.json.tmp
fi
printf 'prompt\\n' >> history.jsonl
mkdir -p projects/test
printf 'transcript\\n' > projects/test/session.jsonl
printf '{"state":true}' > ../.claude.json
`;
      const proc = Bun.spawn([...args, shell!, "-c", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(
        await readFile(path.join(home, ".claude/settings.json"), "utf8"),
      ).toBe("{}");
      expect(
        await readFile(path.join(home, ".claude/plugins/hook.sh"), "utf8"),
      ).toBe("original");
      expect(
        await readFile(path.join(home, ".claude/.credentials.json"), "utf8"),
      ).toBe('{"updated":true}');
      expect(
        await readFile(
          path.join(home, ".claude/projects/test/session.jsonl"),
          "utf8",
        ),
      ).toBe("transcript\n");
      expect(
        await Bun.file(path.join(home, ".claude/future-config.json")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(
          path.join(home, ".claude/shell-snapshots/session.sh"),
        ).exists(),
      ).toBe(false);
      expect(
        await readFile(
          path.join(state.runtimeDir, "future-config.json"),
          "utf8",
        ),
      ).toBe("private");
    } finally {
      if (state) await removeProtectedClaudeState(state);
      await rm(home, { recursive: true, force: true });
    }
  },
);
