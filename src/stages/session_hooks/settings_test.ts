import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildSessionHookSettings,
  SESSION_HOOK_REPORT_SCRIPT,
} from "./settings.ts";

test("Claude input questions never run competing start and attention hooks", () => {
  const { hooks } = JSON.parse(buildSessionHookSettings("claude"));
  for (const [tool, kind] of [
    ["AskUserQuestion", "attention"],
    ["Bash", "start"],
    ["Read", "start"],
  ]) {
    const matches = hooks.PreToolUse.filter((group: { matcher: string }) =>
      new RegExp(group.matcher).test(tool),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].hooks[0].command).toEndWith(`--kind ${kind}`);
  }
  expect(hooks.Stop[0].hooks[0].command).toEndWith("--kind attention");
  expect(hooks.SessionEnd[0].hooks[0].command).toEndWith("--kind stop");
});

test("Claude permission waits notify and tool completion or failure resumes work", () => {
  const { hooks } = JSON.parse(buildSessionHookSettings("claude"));
  const notifications = new RegExp(hooks.Notification[0].matcher);
  for (const event of [
    "permission_prompt",
    "idle_prompt",
    "elicitation_dialog",
  ])
    expect(notifications.test(event)).toBe(true);
  expect(notifications.test("auth_success")).toBe(false);
  expect(hooks.Notification[0].hooks[0].command).toEndWith("--kind attention");
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    expect(hooks[event][0].matcher).toBeUndefined();
    expect(hooks[event][0].hooks[0].command).toEndWith("--kind start");
  }
});

test("Codex requirements parse as TOML, preserve ordinary hooks, and use an absolute managed command", () => {
  const config = Bun.TOML.parse(buildSessionHookSettings("codex")) as {
    features: { hooks: boolean };
    hooks: Record<string, any>;
    allow_managed_hooks_only?: boolean;
  };
  expect(config.features.hooks).toBe(true);
  expect(config.allow_managed_hooks_only).toBeUndefined();
  for (const [event, kind] of [
    ["UserPromptSubmit", "start"],
    ["PreToolUse", "start"],
    ["Stop", "attention"],
    ["SessionEnd", "stop"],
  ]) {
    expect(config.hooks[event][0].hooks[0].command).toBe(
      `${config.hooks.managed_dir}/report --kind ${kind}`,
    );
  }
});

test("Copilot tracks turn completion and filters ask_user by its payload", () => {
  const config = JSON.parse(buildSessionHookSettings("copilot"));
  expect(config.version).toBe(1);
  expect(config.hooks.agentStop[0].bash).toEndWith("--kind attention");
  expect(config.hooks.preToolUse[0].bash).toEndWith(
    "--kind attention --when toolName=ask_user",
  );
  expect(config.hooks.postToolUse[0].bash).toEndWith(
    "--kind start --when toolName=ask_user",
  );
});

test("report forwards argv and stdin, ignores transport failure, and does nothing outside NAS", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-hook-report-"));
  try {
    await writeFile(path.join(dir, "report"), SESSION_HOOK_REPORT_SCRIPT);
    await writeFile(
      path.join(dir, "nas"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$NAS_TEST_ARGS"\ncat > "$NAS_TEST_STDIN"\nexit 7\n',
      { mode: 0o755 },
    );
    const run = (session: string) =>
      Bun.spawn(
        [
          "sh",
          path.join(dir, "report"),
          "--kind",
          "attention",
          "--when",
          "toolName=ask_user",
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            NAS_SESSION_ID: session,
            NAS_TEST_ARGS: `${dir}/args`,
            NAS_TEST_STDIN: `${dir}/stdin`,
          },
          stdin: new Blob(['{"message":"hello"}']),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    expect(await run("").exited).toBe(0);
    expect(await Bun.file(`${dir}/args`).exists()).toBe(false);
    const proc = run("sess_test");
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await readFile(`${dir}/args`, "utf8")).toBe(
      "hook\n--kind\nattention\n--when\ntoolName=ask_user\n",
    );
    expect(await readFile(`${dir}/stdin`, "utf8")).toBe('{"message":"hello"}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
