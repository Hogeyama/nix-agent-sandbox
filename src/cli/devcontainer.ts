import {
  type DevcontainerDisclosure,
  type DevcontainerInitResult,
  type DevcontainerStatus,
  makeDevcontainerLifecycle,
} from "../domain/devcontainer.ts";
import { buildHostEnv } from "../pipeline/host_env.ts";
import type { HostEnv } from "../pipeline/types.ts";
import { parseDevcontainerArgs } from "./devcontainer_args.ts";

export interface DevcontainerCommandClient {
  init(workspace: string, profile: string): Promise<DevcontainerInitResult>;
  up(workspace: string): Promise<DevcontainerStatus>;
  down(workspace: string): Promise<DevcontainerStatus | null>;
  status(workspace: string): Promise<DevcontainerStatus | null>;
}

function makeClient(host: HostEnv): DevcontainerCommandClient {
  const { init, up, down, status } = makeDevcontainerLifecycle(host);
  return { init, up, down, status };
}

function printStatus(status: DevcontainerStatus | null): void {
  if (!status) {
    console.log("Dev Container is not initialized for this workspace.");
    return;
  }
  console.log(`Dev Container: ${status.phase}`);
  console.log(`  workspace: ${status.workspaceId}`);
  console.log(`  profile: ${status.profileName}`);
  if (status.sessionId) console.log(`  session: ${status.sessionId}`);
  if (status.containerId) console.log(`  container: ${status.containerId}`);
  if (status.diagnostic) console.log(`  diagnostic: ${status.diagnostic}`);
}

/**
 * Reopening a folder in a container is where this configuration takes effect,
 * and nas is not on screen there. Say here what it will do.
 */
function printSharing(sharing: readonly DevcontainerDisclosure[]): void {
  if (sharing.length === 0) return;
  const width = Math.max(...sharing.map((entry) => entry.topic.length));
  console.log("");
  console.log("This Dev Container:");
  for (const entry of sharing)
    console.log(`  ${entry.topic.padEnd(width)}  ${entry.detail}`);
}

/** Parse, call the domain clients, and render the result. */
export async function runDevcontainerCommand(
  args: readonly string[],
  cwd = process.cwd(),
  client?: DevcontainerCommandClient,
): Promise<void> {
  const command = parseDevcontainerArgs(args, cwd);
  const domain = client ?? makeClient(buildHostEnv());
  if (command.action === "init") {
    const { registration, sharing, droppedAgentArgs } = await domain.init(
      command.workspace,
      command.profile,
    );
    console.log(`Created ${registration.configPath}`);
    console.log(`Profile: ${registration.profileName}`);
    printSharing(sharing);
    if (droppedAgentArgs.length > 0) {
      console.log("");
      console.log(
        "Profile agentArgs the Codex IDE session cannot use (only -c/--config pairs are passed):",
      );
      for (const arg of droppedAgentArgs) console.log(`  dropped: ${arg}`);
    }
    return;
  }
  const result = await domain[command.action](command.workspace);
  if (command.json) console.log(JSON.stringify(result, null, 2));
  else printStatus(result);
}
