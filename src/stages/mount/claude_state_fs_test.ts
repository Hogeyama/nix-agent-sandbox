import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { makeFsServiceFake } from "../../services/fs.ts";
import {
  prepareProtectedClaudeState,
  removeProtectedClaudeState,
} from "./claude_state_fs.ts";
import {
  MountSetupService,
  MountSetupServiceLive,
} from "./mount_setup_service.ts";

async function withHome(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "nas-claude-test-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("protected state shares only credentials and history writable; unknown configuration is read-only", async () => {
  await withHome(async (home) => {
    const dir = path.join(home, ".claude");
    await mkdir(dir);
    for (const name of [
      "plugins",
      "skills",
      "agents",
      "commands",
      "hooks",
      "sumi",
      "future-feature",
      "shell-snapshots",
    ]) {
      await mkdir(path.join(dir, name));
    }
    await writeFile(path.join(dir, "settings.json"), '{"kept":true}');
    await writeFile(path.join(dir, ".credentials.json"), '{"test":"old"}');
    await writeFile(path.join(home, ".claude.json"), '{"existing":true}');
    const state = await prepareProtectedClaudeState(home);
    try {
      expect(
        state.entries
          .filter((entry) => !entry.readOnly)
          .map((entry) => entry.name)
          .sort(),
      ).toEqual([
        ".credentials.json",
        "file-history",
        "history.jsonl",
        "projects",
      ]);
      for (const name of [
        "settings.json",
        "plugins",
        "skills",
        "agents",
        "commands",
        "hooks",
        "sumi",
        "future-feature",
      ]) {
        expect(
          state.entries.find((entry) => entry.name === name)?.readOnly,
        ).toBe(true);
      }
      expect(
        state.entries.some((entry) => entry.name === "shell-snapshots"),
      ).toBe(false);
      expect(await readFile(path.join(dir, ".credentials.json"), "utf8")).toBe(
        '{"test":"old"}',
      );
      expect(await readFile(state.claudeJson, "utf8")).toBe(
        '{"existing":true}',
      );
      expect((await stat(state.runtimeDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dir, "history.jsonl"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await removeProtectedClaudeState(state);
    }
    expect(await Bun.file(path.join(dir, "settings.json")).exists()).toBe(true);
  });
});

test("first login sources exist and sessions get distinct private roots", async () => {
  await withHome(async (home) => {
    const first = await prepareProtectedClaudeState(home);
    try {
      const second = await prepareProtectedClaudeState(home);
      try {
        expect(first.runtimeDir).not.toBe(second.runtimeDir);
        expect(await readFile(first.claudeJson, "utf8")).toBe("{}\n");
        expect(
          await readFile(path.join(home, ".claude/.credentials.json"), "utf8"),
        ).toBe("{}\n");
        await writeFile(path.join(first.runtimeDir, "private"), "session");
        expect(
          await Bun.file(path.join(second.runtimeDir, "private")).exists(),
        ).toBe(false);
      } finally {
        await removeProtectedClaudeState(second);
      }
    } finally {
      await removeProtectedClaudeState(first);
    }
    expect(await Bun.file(first.claudeJson).exists()).toBe(true);
  });
});

for (const entry of [
  ".claude.json",
  ".claude/.credentials.json",
  ".claude/projects",
]) {
  test(`rejects a writable symlink at ${entry}`, async () => {
    await withHome(async (home) => {
      await mkdir(path.join(home, ".claude"));
      await writeFile(path.join(home, "unrelated"), "untouched");
      await symlink(path.join(home, "unrelated"), path.join(home, entry));
      await expect(prepareProtectedClaudeState(home)).rejects.toThrow(
        "Claude shared state must be",
      );
      expect(await readFile(path.join(home, "unrelated"), "utf8")).toBe(
        "untouched",
      );
    });
  });
}

test("mount setup releases private state on failure while preserving shared history", async () => {
  await withHome(async (home) => {
    let runtimeDir: string | undefined;
    const program = Effect.gen(function* () {
      const service = yield* MountSetupService;
      const state = yield* service.prepareClaudeState(home);
      runtimeDir = state.runtimeDir;
      yield* Effect.promise(() =>
        writeFile(path.join(state.runtimeDir, "cache"), "private"),
      );
      yield* Effect.promise(() =>
        writeFile(path.join(home, ".claude/history.jsonl"), "shared"),
      );
      return yield* Effect.fail(new Error("launch failed"));
    }).pipe(
      Effect.provide(MountSetupServiceLive),
      Effect.provide(makeFsServiceFake().layer),
      Effect.scoped,
    );
    await expect(Effect.runPromise(program)).rejects.toThrow("launch failed");
    expect(runtimeDir).toBeDefined();
    await expect(stat(runtimeDir!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(path.join(home, ".claude/history.jsonl"), "utf8"),
    ).toBe("shared");
  });
});
