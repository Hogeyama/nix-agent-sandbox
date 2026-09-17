import { encodeDynamicEnvOps } from "../../pipeline/env_ops.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";

export interface ComposeBindMount {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
  readonly bind: { readonly create_host_path: false };
}

export interface ComposeAgentService {
  readonly image: string;
  readonly container_name: string;
  readonly working_dir: string;
  readonly command: readonly string[];
  readonly restart: "no";
  readonly logging: { readonly driver: "none" };
  readonly volumes: readonly ComposeBindMount[];
  readonly networks: {
    readonly session: { readonly aliases?: readonly string[] };
  };
  readonly environment: Readonly<Record<string, string>>;
  readonly extra_hosts?: readonly string[];
  readonly shm_size?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ComposeDocument {
  readonly name: string;
  readonly services: { readonly agent: ComposeAgentService };
  readonly networks: {
    readonly session: { readonly external: true; readonly name: string };
  };
}

export function compileCompose(
  container: ContainerPlan,
  containerName: string,
  projectName: string,
): ComposeDocument {
  if (container.network === undefined) {
    throw new Error("[nas] Compose launch requires a named network");
  }
  if (container.network.mode === "container") {
    throw new Error(
      "[nas] Compose launch does not support container network mode",
    );
  }
  if (container.extraRunArgs.length > 0) {
    throw new Error("[nas] Compose launch cannot represent extraRunArgs");
  }

  const environmentEntries: Array<readonly [string, string]> = Object.entries(
    container.env.static,
  ).map(([key, value]) => [key, escapeComposeValue(value)]);
  if (container.env.dynamicOps.length > 0) {
    environmentEntries.push([
      "NAS_ENV_OPS",
      escapeComposeValue(encodeDynamicEnvOps(container.env.dynamicOps)),
    ]);
  }
  const environment = Object.fromEntries(environmentEntries);

  const labels = Object.fromEntries(
    Object.entries(container.labels).map(([key, value]) => [
      key,
      escapeComposeValue(value),
    ]),
  );

  const alias = container.network.alias;
  const service: ComposeAgentService = {
    image: escapeComposeValue(container.image),
    container_name: escapeComposeValue(containerName),
    working_dir: escapeComposeValue(container.workDir),
    command: [
      "/usr/local/bin/nas-devcontainer-idle",
      ...container.command.extraArgs.map(escapeComposeValue),
    ],
    restart: "no",
    logging: { driver: "none" },
    volumes: container.mounts.map((mount) => ({
      type: "bind",
      source: escapeComposeValue(mount.source),
      target: escapeComposeValue(mount.target),
      read_only: mount.readOnly ?? false,
      bind: { create_host_path: false },
    })),
    networks: {
      session:
        alias === undefined ? {} : { aliases: [escapeComposeValue(alias)] },
    },
    environment,
    ...(container.extraHosts.length === 0
      ? {}
      : {
          extra_hosts: container.extraHosts.map(({ host, ip }) =>
            escapeComposeValue(`${host}:${ip}`),
          ),
        }),
    ...(container.shmSize === undefined
      ? {}
      : { shm_size: escapeComposeValue(container.shmSize) }),
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
  };

  return {
    name: escapeComposeValue(projectName),
    services: { agent: service },
    networks: {
      session: {
        external: true,
        name: escapeComposeValue(container.network.name),
      },
    },
  };
}

export function serializeCompose(document: ComposeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function escapeComposeValue(value: string): string {
  return value.split("$").join("$$");
}
