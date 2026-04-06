/**
 * nas container サブコマンド
 */

import { cleanNasContainers } from "../container_clean.ts";
import { exitOnCliError } from "./helpers.ts";

export async function runContainerCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));

  try {
    if (sub === "clean") {
      const result = await cleanNasContainers();
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
    console.error("  Usage: nas container clean");
    process.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}
