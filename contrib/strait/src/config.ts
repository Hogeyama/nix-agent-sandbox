// strait.json: the only knobs strait exposes.
//
// Network settings are deliberately absent. Hosts, TLS termination and the
// request filter are fixed in code; accepting srt's network section here
// would let a config reopen `excludeDomains` or an external proxy.

export interface FilesystemConfig {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
}

export interface StraitConfig {
  githubRepos: string[];
  filesystem: FilesystemConfig;
  /** Let the sandbox ask to run commands on the host, each one approved. */
  hostExec: boolean;
}

export const DEFAULT_FILESYSTEM: FilesystemConfig = {
  allowWrite: ["."],
  denyWrite: [".claude"],
  denyRead: ["/tmp", "~/.ssh", "~/.aws", "~/.config/gh"],
  // srt bridges its proxy through a socket under /tmp; denying /tmp hides it.
  allowRead: ["/tmp/claude-http-*.sock"],
};

const FS_KEYS = Object.keys(DEFAULT_FILESYSTEM) as (keyof FilesystemConfig)[];

export function parseConfig(text: string): StraitConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`strait.json is not valid JSON: ${(e as Error).message}`);
  }
  const top = record(raw, "strait.json");
  rejectUnknown(top, ["githubRepos", "filesystem", "hostExec"], "strait.json");

  const githubRepos = stringArray(top.githubRepos ?? [], "githubRepos");
  for (const r of githubRepos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
      throw new Error(`githubRepos: "${r}" is not owner/name`);
    }
  }

  const filesystem = { ...DEFAULT_FILESYSTEM };
  if (top.filesystem !== undefined) {
    const fs = record(top.filesystem, "filesystem");
    rejectUnknown(fs, FS_KEYS, "filesystem");
    for (const key of FS_KEYS) {
      if (fs[key] !== undefined) {
        filesystem[key] = stringArray(fs[key], `filesystem.${key}`);
      }
    }
  }
  const hostExec = top.hostExec ?? false;
  if (typeof hostExec !== "boolean") {
    throw new Error("hostExec must be true or false");
  }
  return { githubRepos, filesystem, hostExec };
}

function record(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${where} must be an object`);
  }
  return v as Record<string, unknown>;
}

function rejectUnknown(
  obj: Record<string, unknown>,
  known: readonly string[],
  where: string,
) {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
}

function stringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`${where} must be an array of strings`);
  }
  return v;
}
