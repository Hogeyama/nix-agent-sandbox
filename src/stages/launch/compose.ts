import { encodeDynamicEnvOps } from "../../pipeline/env_ops.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import { AGENT_CAP_ADD, AGENT_NO_NEW_PRIVILEGES } from "./hardening.ts";

export interface ComposeBindMount {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
  readonly bind: { readonly create_host_path: false };
}

export interface ComposeNamedVolumeMount {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
}

export type ComposeMount = ComposeBindMount | ComposeNamedVolumeMount;

export interface ComposeAgentService {
  readonly image: string;
  readonly container_name: string;
  readonly working_dir: string;
  readonly command: readonly string[];
  readonly restart: "no";
  readonly logging: { readonly driver: "none" };
  /** Same privilege settings as compileLaunchOpts; see hardening.ts. */
  readonly security_opt: readonly string[];
  readonly cap_drop: readonly string[];
  readonly cap_add: readonly string[];
  readonly volumes: readonly ComposeMount[];
  /**
   * `network_mode: "container:<name>"` joins the named container's network
   * namespace — the DinD arrangement, where the sidecar owns the namespace
   * and the session network. Mutually exclusive with `networks`, and Docker
   * rejects `extra_hosts` in this mode (the namespace owner's /etc/hosts is
   * shared instead), so both are omitted.
   */
  readonly network_mode?: string;
  readonly networks?: {
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
  /**
   * Omitted in container network mode: no service references the session
   * network, so declaring it would be dead configuration.
   */
  readonly networks?: {
    readonly session: { readonly external: true; readonly name: string };
  };
  /**
   * Named volumes the agent mounts (e.g. the DinD shared tmp volume).
   * `external: true` because nas creates and destroys them outside the
   * Compose lifecycle.
   */
  readonly volumes?: Readonly<Record<string, { readonly external: true }>>;
}

export function compileCompose(
  container: ContainerPlan,
  containerName: string,
  projectName: string,
): ComposeDocument {
  if (container.network === undefined) {
    throw new Error("[nas] Compose launch requires a named network");
  }
  if (container.extraRunArgs.length > 0) {
    throw new Error("[nas] Compose launch cannot represent extraRunArgs");
  }
  const containerNetns = container.network.mode === "container";

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

  const volumes: ComposeMount[] = [
    ...container.mounts.map((mount): ComposeBindMount => {
      return {
        type: "bind",
        source: escapeComposeValue(mount.source),
        target: escapeComposeValue(mount.target),
        read_only: mount.readOnly ?? false,
        bind: { create_host_path: false },
      };
    }),
    ...container.namedVolumes.map((volume): ComposeNamedVolumeMount => {
      return {
        type: "volume",
        source: escapeComposeValue(volume.name),
        target: escapeComposeValue(volume.target),
        read_only: volume.readOnly ?? false,
      };
    }),
  ];

  const alias =
    container.network.mode === "network" ? container.network.alias : undefined;
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
    security_opt: [AGENT_NO_NEW_PRIVILEGES],
    cap_drop: ["ALL"],
    cap_add: [...AGENT_CAP_ADD],
    volumes,
    ...(containerNetns
      ? {
          network_mode: escapeComposeValue(
            `container:${container.network.containerName}`,
          ),
        }
      : {
          networks: {
            session:
              alias === undefined
                ? {}
                : { aliases: [escapeComposeValue(alias)] },
          },
        }),
    environment,
    // Host mappings are meaningless to a container joining another
    // container's namespace — the namespace owner (the DinD sidecar) already
    // carries them, mirroring compileLaunchOpts.
    ...(!containerNetns && container.extraHosts.length > 0
      ? {
          extra_hosts: container.extraHosts.map(({ host, ip }) =>
            escapeComposeValue(`${host}:${ip}`),
          ),
        }
      : {}),
    ...(container.shmSize === undefined
      ? {}
      : { shm_size: escapeComposeValue(container.shmSize) }),
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
  };

  return {
    name: escapeComposeValue(projectName),
    services: { agent: service },
    ...(!containerNetns && container.network.mode === "network"
      ? {
          networks: {
            session: {
              external: true as const,
              name: escapeComposeValue(container.network.name),
            },
          },
        }
      : {}),
    ...(container.namedVolumes.length > 0
      ? {
          volumes: Object.fromEntries(
            container.namedVolumes.map((volume) => [
              volume.name,
              { external: true as const },
            ]),
          ),
        }
      : {}),
  };
}

export function serializeCompose(document: ComposeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function escapeComposeValue(value: string): string {
  return value.split("$").join("$$");
}
