import {
  type DevcontainerRegistration,
  type DevcontainerStatus,
  makeDevcontainerClient,
  makeDevcontainerSupervisorClient,
} from "../domain/devcontainer.ts";
import { buildHostEnv } from "../pipeline/host_env.ts";
import type { HostEnv } from "../pipeline/types.ts";
import { parseDevcontainerArgs } from "./devcontainer_args.ts";

export interface DevcontainerCommandClient {
  init(workspace: string, profile: string): Promise<DevcontainerRegistration>;
  up(workspace: string): Promise<DevcontainerStatus>;
  down(workspace: string): Promise<DevcontainerStatus | null>;
  status(workspace: string): Promise<DevcontainerStatus | null>;
}

function makeClient(host: HostEnv): DevcontainerCommandClient {
  const registration = makeDevcontainerClient(host);
  const supervisor = makeDevcontainerSupervisorClient(host);
  return {
    init: registration.init,
    up: supervisor.up,
    down: supervisor.down,
    status: supervisor.status,
  };
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

/** Parse, call the domain clients, and render the result. */
export async function runDevcontainerCommand(
  args: readonly string[],
  cwd = process.cwd(),
  client?: DevcontainerCommandClient,
): Promise<void> {
  const command = parseDevcontainerArgs(args, cwd);
  const domain = client ?? makeClient(buildHostEnv());
  if (command.action === "init") {
    const registration = await domain.init(command.workspace, command.profile);
    console.log(`Created ${registration.configPath}`);
    console.log(`Profile: ${registration.profileName}`);
    return;
  }
  const result = await domain[command.action](command.workspace);
  if (command.json) console.log(JSON.stringify(result, null, 2));
  else printStatus(result);
}
