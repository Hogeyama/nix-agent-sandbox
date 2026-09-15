import * as path from "node:path";

export type DevcontainerCommand =
  | {
      readonly action: "init";
      readonly workspace: string;
      readonly profile: string;
    }
  | {
      readonly action: "up" | "down" | "status";
      readonly workspace: string;
      readonly json: boolean;
    };

const ACTIONS = new Set(["init", "up", "down", "status"]);

export function parseDevcontainerArgs(
  args: readonly string[],
  cwd: string,
): DevcontainerCommand {
  let action: string | null = null;
  let workspace = cwd;
  let profile: string | null = null;
  let json = false;
  let sawWorkspace = false;
  let sawProfile = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--")
      throw new Error("devcontainer does not accept agent arguments");
    if (arg === "--workspace" || arg === "--profile") {
      const value = args[++index];
      if (!value || value.startsWith("-"))
        throw new Error(`${arg} requires a value`);
      if (arg === "--workspace") {
        if (sawWorkspace)
          throw new Error("--workspace may only be specified once");
        sawWorkspace = true;
        workspace = path.resolve(cwd, value);
      } else {
        if (sawProfile) throw new Error("--profile may only be specified once");
        sawProfile = true;
        profile = value;
      }
      continue;
    }
    if (arg === "--json") {
      if (json) throw new Error("--json may only be specified once");
      json = true;
      continue;
    }
    if (arg.startsWith("-"))
      throw new Error(`unknown devcontainer option: ${arg}`);
    if (!ACTIONS.has(arg))
      throw new Error(`unknown devcontainer action: ${arg}`);
    if (action !== null)
      throw new Error("exactly one devcontainer action is required");
    action = arg;
  }

  if (action === null) throw new Error("devcontainer action is required");
  if (action !== "init" && profile !== null)
    throw new Error("--profile is only supported by init");
  if (action === "init") {
    if (json) throw new Error("--json is not supported by init");
    return { action, workspace, profile: profile ?? "claude" };
  }
  return { action: action as "up" | "down" | "status", workspace, json };
}

export function parseDevcontainerSupervisorArgs(args: readonly string[]): {
  readonly workspace: string;
  readonly sessionId: string;
} {
  if (args[0] !== "_supervise")
    throw new Error("invalid internal devcontainer action");
  let workspace: string | null = null;
  let sessionId: string | null = null;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag !== "--workspace" && flag !== "--session")
      throw new Error(`unknown internal devcontainer option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("-"))
      throw new Error(`${flag} requires a value`);
    if (flag === "--workspace") {
      if (workspace !== null)
        throw new Error("--workspace may only be specified once");
      workspace = value;
    } else {
      if (sessionId !== null)
        throw new Error("--session may only be specified once");
      sessionId = value;
    }
  }
  if (!workspace || !sessionId)
    throw new Error(
      "internal devcontainer supervisor requires workspace and session",
    );
  return { workspace, sessionId };
}
