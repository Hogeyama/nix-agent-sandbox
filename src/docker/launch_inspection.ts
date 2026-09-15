import { $ } from "bun";

export interface DockerLaunchImage {
  readonly id: string;
  readonly user: string;
  readonly entrypoint: readonly string[] | null;
}

export interface DockerLaunchMount {
  readonly type: string;
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface DockerLaunchInspection {
  readonly id: string;
  readonly imageId: string;
  readonly running: boolean;
  readonly config: {
    readonly image: string;
    readonly user: string;
    readonly entrypoint: readonly string[] | null;
    readonly command: readonly string[] | null;
    readonly workingDir: string;
  };
  readonly mounts: readonly DockerLaunchMount[];
  readonly environment: readonly string[];
  readonly networkMode: string;
  readonly networks: readonly string[];
  readonly privileged: boolean;
  readonly capAdd: readonly string[];
  readonly capDrop: readonly string[];
  readonly securityOpt: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

export function decodeDockerLaunchInspection(
  value: unknown,
): DockerLaunchInspection {
  const root = decodeSingleInspectObject(value, "Docker container inspect");
  const state = requiredRecord(root, "State", "State");
  const config = requiredRecord(root, "Config", "Config");
  const hostConfig = requiredRecord(root, "HostConfig", "HostConfig");
  const networkSettings = requiredRecord(
    root,
    "NetworkSettings",
    "NetworkSettings",
  );
  const networkMap = requiredRecord(
    networkSettings,
    "Networks",
    "NetworkSettings.Networks",
  );

  const mounts = requiredArray(root, "Mounts", "Mounts").map(
    (mount, index): DockerLaunchMount => {
      const path = `Mounts[${index}]`;
      const record = recordValue(mount, path);
      return {
        type: requiredString(record, "Type", `${path}.Type`),
        source: requiredString(record, "Source", `${path}.Source`),
        target: requiredString(record, "Destination", `${path}.Destination`),
        readOnly: !requiredBoolean(record, "RW", `${path}.RW`),
      };
    },
  );

  return {
    id: requiredString(root, "Id", "Id"),
    imageId: requiredString(root, "Image", "Image"),
    running: requiredBoolean(state, "Running", "State.Running"),
    config: {
      image: requiredString(config, "Image", "Config.Image"),
      user: requiredString(config, "User", "Config.User"),
      entrypoint: requiredNullableStringArray(
        config,
        "Entrypoint",
        "Config.Entrypoint",
      ),
      command: requiredNullableStringArray(config, "Cmd", "Config.Cmd"),
      workingDir: requiredString(config, "WorkingDir", "Config.WorkingDir"),
    },
    mounts,
    environment: requiredStringArray(config, "Env", "Config.Env"),
    networkMode: requiredString(
      hostConfig,
      "NetworkMode",
      "HostConfig.NetworkMode",
    ),
    networks: Object.keys(networkMap),
    privileged: requiredBoolean(
      hostConfig,
      "Privileged",
      "HostConfig.Privileged",
    ),
    capAdd:
      requiredNullableStringArray(hostConfig, "CapAdd", "HostConfig.CapAdd") ??
      [],
    capDrop:
      requiredNullableStringArray(
        hostConfig,
        "CapDrop",
        "HostConfig.CapDrop",
      ) ?? [],
    securityOpt:
      requiredNullableStringArray(
        hostConfig,
        "SecurityOpt",
        "HostConfig.SecurityOpt",
      ) ?? [],
    labels: requiredNullableStringRecord(config, "Labels", "Config.Labels"),
  };
}

export function decodeDockerLaunchImage(value: unknown): DockerLaunchImage {
  const root = decodeSingleInspectObject(value, "Docker image inspect");
  const config = requiredRecord(root, "Config", "Config");
  return {
    id: requiredString(root, "Id", "Id"),
    user: Object.hasOwn(config, "User")
      ? requiredString(config, "User", "Config.User")
      : "",
    entrypoint: Object.hasOwn(config, "Entrypoint")
      ? requiredNullableStringArray(config, "Entrypoint", "Config.Entrypoint")
      : null,
  };
}

export async function dockerInspectLaunch(
  id: string,
): Promise<DockerLaunchInspection> {
  const result = await $`docker inspect ${id}`.quiet();
  return decodeDockerLaunchInspection(parseInspectJson(result.stdout));
}

export async function dockerInspectLaunchImage(
  reference: string,
): Promise<DockerLaunchImage> {
  const result = await $`docker image inspect ${reference}`.quiet();
  return decodeDockerLaunchImage(parseInspectJson(result.stdout));
}

function parseInspectJson(stdout: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(stdout).toString());
  } catch {
    throw new Error("Docker inspect returned invalid JSON");
  }
}

function decodeSingleInspectObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label}: expected exactly one object`);
  }
  return recordValue(value[0], label);
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requiredValue(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new Error(`${path}: required field is missing`);
  }
  return record[key];
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  return recordValue(requiredValue(record, key, path), path);
}

function requiredArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] {
  const value = requiredValue(record, key, path);
  if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = requiredValue(record, key, path);
  if (typeof value !== "string") throw new Error(`${path}: expected string`);
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = requiredValue(record, key, path);
  if (typeof value !== "boolean") {
    throw new Error(`${path}: expected boolean`);
  }
  return value;
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  return stringArrayValue(requiredValue(record, key, path), path);
}

function requiredNullableStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string[] | null {
  const value = requiredValue(record, key, path);
  return value === null ? null : stringArrayValue(value, path);
}

function stringArrayValue(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${path}[${index}]: expected string`);
    }
    return entry;
  });
}

function requiredNullableStringRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, string> {
  const value = requiredValue(record, key, path);
  if (value === null) return {};
  const decoded = recordValue(value, path);
  const entries: Array<readonly [string, string]> = [];
  for (const [entryKey, entryValue] of Object.entries(decoded)) {
    if (typeof entryValue !== "string") {
      throw new Error(`${path}: expected string values`);
    }
    entries.push([entryKey, entryValue]);
  }
  return Object.fromEntries(entries);
}
