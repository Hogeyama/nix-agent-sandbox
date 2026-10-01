import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildAgentHookSettings,
  buildCodexMaskHookScript,
  CODEX_MASK_HOOK_COMMANDS,
  SESSION_HOOK_REPORT_SCRIPT,
} from "./settings.ts";

test("Claude input questions never run competing start and attention hooks", () => {
  const { hooks } = JSON.parse(buildAgentHookSettings("claude"));
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
  const { hooks } = JSON.parse(buildAgentHookSettings("claude"));
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
  const config = Bun.TOML.parse(buildAgentHookSettings("codex")) as {
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
  const config = JSON.parse(buildAgentHookSettings("copilot"));
  expect(config.version).toBe(1);
  expect(config.hooks.agentStop[0].bash).toEndWith("--kind attention");
  expect(config.hooks.preToolUse[0].bash).toEndWith(
    "--kind attention --when toolName=ask_user",
  );
  expect(config.hooks.postToolUse[0].bash).toEndWith(
    "--kind start --when toolName=ask_user",
  );
});

test("Codex composes only NAS masking and lifecycle hooks in one requirements file", () => {
  for (const lifecycle of [true, false]) {
    const config = Bun.TOML.parse(
      buildAgentHookSettings("codex", {
        lifecycle,
        maskSocketPath: "/run/mask.sock",
      }),
    ) as any;
    const prompt = config.hooks.UserPromptSubmit.flatMap(
      (group: any) => group.hooks,
    );
    expect(prompt).toHaveLength(lifecycle ? 2 : 1);
    expect(prompt[0].command).toBe(CODEX_MASK_HOOK_COMMANDS.prompt);
    expect(config.hooks.PostToolUse[0].hooks[0].command).toBe(
      CODEX_MASK_HOOK_COMMANDS["post-tool"],
    );
    expect(config.features.hooks).toBe(true);
    expect(config.hooks.Stop !== undefined).toBe(lifecycle);
    expect(config.hooks.PostToolUseFailure).toBeUndefined();
  }
});

test("Copilot installs result and transformed-prompt masking independently of lifecycle hooks", () => {
  for (const lifecycle of [true, false]) {
    const config = JSON.parse(
      buildAgentHookSettings("copilot", {
        lifecycle,
        maskSocketPath: "/run/mask.sock",
      }),
    );
    expect(config.hooks.postToolUse).toHaveLength(lifecycle ? 2 : 1);
    for (const [event, action] of [
      ["postToolUse", "post-tool"],
      ["userPromptTransformed", "prompt"],
    ]) {
      expect(config.hooks[event][0]).toEqual({
        type: "command",
        exec: "/opt/nas/sumi/sumi",
        args: [
          "hook",
          "--agent",
          "copilot",
          action,
          "--server",
          "/run/mask.sock",
        ],
        timeoutSec: 20,
      });
    }
    expect(config.hooks.agentStop !== undefined).toBe(lifecycle);
    // Config-file submitted-prompt hooks cannot block or replace prompts.
    expect(
      JSON.stringify(config.hooks.userPromptSubmitted ?? []),
    ).not.toContain("sumi");
    expect(config.hooks.postToolUseFailure).toBeUndefined();
  }
});

test("mask socket paths survive exec arguments and the Codex shim literally", async () => {
  const socket = "/run/it's a $(printf injected) socket.sock";
  const copilot = JSON.parse(
    buildAgentHookSettings("copilot", {
      lifecycle: false,
      maskSocketPath: socket,
    }),
  );
  for (const event of ["postToolUse", "userPromptTransformed"]) {
    expect(copilot.hooks[event][0].args.at(-1)).toBe(socket);
  }
  for (const action of ["post-tool", "prompt"] as const) {
    const script = buildCodexMaskHookScript(action, socket);
    const command = script.split("\n")[1].replace(/^exec /, "");
    const proc = Bun.spawn(
      ["sh", "-c", `set -- ${command}; printf '%s\\n' "$@"`],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      "/opt/nas/sumi/sumi",
      "hook",
      "--agent",
      "codex",
      action,
      "--server",
      socket,
    ]);
  }
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
