import { SUMI_CONTAINER_PATH } from "../maskfs.ts";

/** Container-only managed hooks. Existing user/project settings stay intact. */
export const AGENT_HOOKS_DIR = "/opt/nas/agent-hooks";
export const SESSION_HOOK_REPORT = `${AGENT_HOOKS_DIR}/report`;

export const CODEX_MASK_HOOK_COMMANDS = {
  "post-tool": `${AGENT_HOOKS_DIR}/mask-codex-post-tool`,
  prompt: `${AGENT_HOOKS_DIR}/mask-codex-prompt`,
} as const;

export function buildCodexMaskHookScript(
  event: keyof typeof CODEX_MASK_HOOK_COMMANDS,
  socketPath: string,
): string {
  const socket = `'${socketPath.replaceAll("'", "'\\''")}'`;
  // The entrypoint dispatches these immutable scripts before supervising Bash.
  // Use the real interpreter even when /bin/sh points to the Bash wrapper;
  // -p also prevents BASH_ENV and exported functions from running in this path.
  return `#!/tmp/nas-bash-override/bash.real -p
exec ${SUMI_CONTAINER_PATH} hook --agent codex ${event} --socket ${socket}
`;
}

export type HookAgent = "claude" | "codex" | "copilot";

const command = (kind: string) => `${SESSION_HOOK_REPORT} --kind ${kind}`;

export interface AgentHookOptions {
  readonly lifecycle: boolean;
  readonly maskSocketPath?: string;
}

export function buildAgentHookSettings(
  agent: HookAgent,
  options: AgentHookOptions = { lifecycle: true },
): string {
  if (agent === "copilot") {
    // A shell here would enter the Bash supervisor before sumi can return its
    // withheld response when the mask broker is unavailable.
    const maskHook = (event: string) => ({
      type: "command",
      exec: SUMI_CONTAINER_PATH,
      args: [
        "hook",
        "--agent",
        agent,
        event,
        "--socket",
        options.maskSocketPath,
      ],
      timeoutSec: 20,
    });
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
          ...(options.maskSocketPath || options.lifecycle
            ? {
                postToolUse: [
                  ...(options.maskSocketPath ? [maskHook("post-tool")] : []),
                  ...(options.lifecycle
                    ? hook("start", " --when toolName=ask_user")
                    : []),
                ],
              }
            : {}),
          ...(options.maskSocketPath
            ? {
                userPromptTransformed: [maskHook("prompt")],
              }
            : {}),
          ...(options.lifecycle
            ? {
                userPromptSubmitted: hook("start"),
                preToolUse: hook("attention", " --when toolName=ask_user"),
                agentStop: hook("attention"),
                sessionEnd: hook("stop"),
              }
            : {}),
        },
      },
      null,
      2,
    )}\n`;
  }

  const hook = (kind: string, matcher?: string, timeout = 5) => [
    {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command: command(kind), timeout }],
    },
  ];
  const hooks: Record<
    string,
    {
      matcher?: string;
      hooks: { type: string; command: string; timeout: number }[];
    }[]
  > = {
    ...(options.lifecycle
      ? {
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
          // Codex clamps SessionEnd timeouts above three seconds with a warning.
          SessionEnd: hook("stop", undefined, agent === "codex" ? 3 : 5),
        }
      : {}),
  };
  // Claude's mask hooks remain a separate read-only managed drop-in owned by
  // MaskFilterService. Codex has one requirements file, so compose only our
  // own mask and lifecycle hooks here; entrypoint rejects pre-existing policy.
  if (agent === "codex" && options.maskSocketPath) {
    for (const [event, action] of [
      ["PostToolUse", "post-tool"],
      ["UserPromptSubmit", "prompt"],
    ] as const) {
      hooks[event] = [
        {
          hooks: [
            {
              type: "command",
              command: CODEX_MASK_HOOK_COMMANDS[action],
              timeout: 20,
            },
          ],
        },
        ...(hooks[event] ?? []),
      ];
    }
  }
  if (agent === "claude") return `${JSON.stringify({ hooks }, null, 2)}\n`;

  // Enable managed hooks even when the user's ordinary config disables
  // hooks, without disabling or trusting any user/project/plugin hooks.
  const lines = [
    "[features]",
    "hooks = true",
    "",
    "[hooks]",
    `managed_dir = ${JSON.stringify(AGENT_HOOKS_DIR)}`,
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
