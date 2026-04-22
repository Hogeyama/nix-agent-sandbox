/**
 * nas container サブコマンド
 */

import { NAS_KIND_LABEL } from "../docker/nas_resources.ts";
import {
  makeContainerLifecycleClient,
  makeContainerQueryClient,
} from "../domain/container.ts";
import { getSocketDir } from "../dtach/client.ts";
import { exitOnCliError, hasFormatJson } from "./helpers.ts";

// Module-level clients: `Layer` は pure description (副作用なし) なので
// module-level const は安全。`ui/data.ts` の同パターンと整合させ、CLI process
// per invocation 環境では関数内 const と実害差なし。
const containerQueryClient = makeContainerQueryClient();
const lifecycleClient = makeContainerLifecycleClient();

export async function runContainerCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));
  const formatJson = hasFormatJson(nasArgs);

  try {
    if (sub === "list") {
      const managed = await containerQueryClient.listManaged();
      if (formatJson) {
        const items = managed.map((c) => ({
          name: c.name,
          running: c.running,
          kind: c.labels[NAS_KIND_LABEL] ?? null,
          networks: c.networks,
          startedAt: c.startedAt,
        }));
        console.log(JSON.stringify(items));
        return;
      }
      if (managed.length === 0) {
        console.log("[nas] No nas containers found.");
        return;
      }
      for (const c of managed) {
        const status = c.running ? "running" : "stopped";
        const kind = c.labels[NAS_KIND_LABEL] ?? "unknown";
        console.log(`  ${c.name}  ${kind}  ${status}  ${c.startedAt}`);
      }
      return;
    }

    if (sub === "clean") {
      const result = await lifecycleClient.cleanContainers(getSocketDir());
      const parts: string[] = [];
      if (result.removedContainers.length > 0) {
        parts.push(`${result.removedContainers.length} container(s)`);
      }
      if (result.removedNetworks.length > 0) {
        parts.push(`${result.removedNetworks.length} network(s)`);
      }
      if (result.removedVolumes.length > 0) {
        parts.push(`${result.removedVolumes.length} volume(s)`);
      }
      if (parts.length === 0) {
        console.log("[nas] No unused nas sidecars found.");
        return;
      }
      console.log(`[nas] Removed ${parts.join(", ")}.`);
      if (result.removedContainers.length > 0) {
        console.log(`[nas] Sidecars: ${result.removedContainers.join(", ")}`);
      }
      if (result.removedNetworks.length > 0) {
        console.log(`[nas] Networks: ${result.removedNetworks.join(", ")}`);
      }
      if (result.removedVolumes.length > 0) {
        console.log(`[nas] Volumes: ${result.removedVolumes.join(", ")}`);
      }
      return;
    }

    console.error(`[nas] Unknown container subcommand: ${sub}`);
    console.error("  Usage: nas container [list|clean] [--format json]");
    process.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}
