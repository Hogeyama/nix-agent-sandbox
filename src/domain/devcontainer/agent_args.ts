import type { AgentType } from "../../agents/types.ts";

export interface FilteredDevcontainerAgentArgs {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

/**
 * The Codex VS Code extension spawns `codex ... app-server`, not the TUI, so
 * only `-c`/`--config` key=value overrides may reach the launch argv. TUI
 * flags (--yolo, --sandbox, ...) would fail the app-server launch invisibly.
 * The terminal CLI path does not use this filter; see compose_stage.ts.
 */
function isConfigKeyValue(value: string): boolean {
  return !value.startsWith("-") && value.includes("=");
}

export function filterDevcontainerAgentArgs(
  agent: AgentType,
  agentArgs: readonly string[],
): FilteredDevcontainerAgentArgs {
  if (agent !== "codex") return { kept: agentArgs, dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let index = 0; index < agentArgs.length; index++) {
    const arg = agentArgs[index];
    if (arg === "-c" || arg === "--config") {
      const value = agentArgs[index + 1];
      if (value !== undefined && isConfigKeyValue(value)) {
        kept.push(arg, value);
        index += 1;
      } else {
        // A -c whose value is missing or not key=value would crash the
        // app-server launch; drop only the flag so the next arg is judged on
        // its own merits.
        dropped.push(arg);
      }
      continue;
    }
    // clap also accepts the attached short form (-cmodel=x), but it is rare
    // enough that keeping a third syntax is not worth it: it drops here with
    // an init-time warning, and `-c model=x` works instead.
    if (arg.startsWith("-c=") || arg.startsWith("--config=")) {
      if (isConfigKeyValue(arg.slice(arg.indexOf("=") + 1))) {
        kept.push(arg);
      } else {
        dropped.push(arg);
      }
      continue;
    }
    dropped.push(arg);
  }
  return { kept, dropped };
}
