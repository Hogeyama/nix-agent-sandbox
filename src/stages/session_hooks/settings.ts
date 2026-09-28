/** Container-only lifecycle hooks. Existing user/project settings stay intact. */
export const SESSION_HOOKS_DIR = "/opt/nas/session-hooks";
export const SESSION_HOOK_REPORT = `${SESSION_HOOKS_DIR}/report`;

export type HookAgent = "claude" | "codex" | "copilot";

const command = (kind: string) => `${SESSION_HOOK_REPORT} --kind ${kind}`;

export function buildSessionHookSettings(agent: HookAgent): string {
  if (agent === "copilot") {
    const hook = (kind: string, condition = "") => [
      {
        type: "command",
        bash: `${command(kind)}${condition}`,
        timeoutSec: 5,
      },
    ];
    return `${JSON.stringify(
      {
        version: 1,
        hooks: {
          userPromptSubmitted: hook("start"),
          preToolUse: hook("attention", " --when toolName=ask_user"),
          postToolUse: hook("start", " --when toolName=ask_user"),
          agentStop: hook("attention"),
          sessionEnd: hook("stop"),
        },
      },
      null,
      2,
    )}\n`;
  }

  const hook = (kind: string, matcher?: string) => [
    {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command: command(kind), timeout: 5 }],
    },
  ];
  const hooks = {
    UserPromptSubmit: hook("start"),
    PreToolUse:
      agent === "claude"
        ? [
            ...hook("start", "^(?!AskUserQuestion$).*"),
            ...hook("attention", "^AskUserQuestion$"),
          ]
        : hook("start"),
    ...(agent === "claude"
      ? {
          PostToolUse: hook("start"),
          PostToolUseFailure: hook("start"),
          Notification: hook(
            "attention",
            "^(permission_prompt|idle_prompt|elicitation_dialog)$",
          ),
        }
      : {}),
    Stop: hook("attention"),
    SessionEnd: hook("stop"),
  };
  if (agent === "claude") return `${JSON.stringify({ hooks }, null, 2)}\n`;

  // Enable the lifecycle hooks even when the user's ordinary config disables
  // hooks, without disabling or trusting any user/project/plugin hooks.
  const lines = [
    "[features]",
    "hooks = true",
    "",
    "[hooks]",
    `managed_dir = ${JSON.stringify(SESSION_HOOKS_DIR)}`,
  ];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      lines.push("", `[[hooks.${event}]]`);
      if (group.matcher !== undefined)
        lines.push(`matcher = ${JSON.stringify(group.matcher)}`);
      for (const handler of group.hooks) {
        lines.push(
          `[[hooks.${event}.hooks]]`,
          'type = "command"',
          `command = ${JSON.stringify(handler.command)}`,
          `timeout = ${handler.timeout}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** stdin passes through unchanged. Transport failures must not fail a turn. */
export const SESSION_HOOK_REPORT_SCRIPT = `#!/bin/sh
if [ -n "\${NAS_SESSION_ID:-}" ]; then
  nas hook "$@" || true
fi
exit 0
`;
