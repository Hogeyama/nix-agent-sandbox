/**
 * nas container サブコマンド
 */

import { cleanNasContainers } from "../container_clean.ts";
import {
  type DockerContainerDetails,
  dockerInspectContainer,
  dockerListContainerNames,
} from "../docker/client.ts";
import {
  isNasManagedContainer,
  NAS_KIND_LABEL,
} from "../docker/nas_resources.ts";
import { exitOnCliError, hasFormatJson } from "./helpers.ts";

/**
 * Pick fulfilled `dockerInspectContainer` results, silently dropping rejected
 * ones so a single broken container does not abort `nas container list`.
 *
 * Silent skip semantics match the UI's `for` + skip in
 * `ContainerQueryService.listManaged`, and keep `--format json` output as a
 * pipe-friendly array (no stderr noise interleaved).
 *
 * NOTE: A future observability improvement could surface skipped container
 * inspect failures via stderr (warning) without polluting `--format json`
 * stdout. Out of scope for this commit; tracked alongside #9.
 */
export function pickFulfilledContainerDetails(
  results: PromiseSettledResult<DockerContainerDetails>[],
): DockerContainerDetails[] {
  return results
    .filter(
      (r): r is PromiseFulfilledResult<DockerContainerDetails> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);
}

export async function runContainerCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));
  const formatJson = hasFormatJson(nasArgs);

  try {
    if (sub === "list") {
      const names = await dockerListContainerNames();
      const settled = await Promise.allSettled(
        names.map((name) => dockerInspectContainer(name)),
      );
      const details = pickFulfilledContainerDetails(settled);
      const managed = details.filter((c) =>
        isNasManagedContainer(c.labels, c.name),
      );
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
    console.error("  Usage: nas container [list|clean] [--format json]");
    process.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}
