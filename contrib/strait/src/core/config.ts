// strait.json: the only knobs strait exposes.
//
// srt's network section is deliberately absent: TLS termination and the
// request filter are fixed in code, and accepting that section would let a
// config reopen `excludeDomains` or an external proxy. What a config can do is
// add a host (`hosts`), which is always TLS-terminated and filtered, and
// where only the credential strait issues for it is let through.

import { HOSTEXEC_HOST } from "./hostexec.ts";
import { HOSTS, type HostRule } from "./policy.ts";

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
  /** Put the session ID in Claude Code's status line (statusline.ts). */
  statusLine: boolean;
  /** Extra hosts, by exact lowercase name, with the credential each takes. */
  hosts: Record<string, HostRule & { credential?: { env: string } }>;
}

// Exact names only: a wildcard would admit hosts nobody reviewed.
const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// An HTTP field name (RFC 9110 token), lowercase so it compares as srt does.
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Headers a credential must not be carried in: framing, routing, cookies. */
const NOT_CREDENTIAL_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "proxy-authorization",
]);
/** strait's own credentials; each goes only to the host it belongs to. */
const RESERVED_ENV = new Set([
  "GH_TOKEN",
  "STRAIT_GIT_AUTH",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);

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
  rejectUnknown(
    top,
    ["githubRepos", "filesystem", "hostExec", "statusLine", "hosts"],
    "strait.json",
  );

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
  const statusLine = top.statusLine ?? true;
  if (typeof statusLine !== "boolean") {
    throw new Error("statusLine must be true or false");
  }
  return {
    githubRepos,
    filesystem,
    hostExec,
    statusLine,
    hosts: parseHosts(top.hosts ?? {}),
  };
}

function parseHosts(v: unknown): StraitConfig["hosts"] {
  const hosts: StraitConfig["hosts"] = {};
  const envs = new Set<string>();
  for (const [host, value] of Object.entries(record(v, "hosts"))) {
    const where = `hosts.${host}`;
    if (!HOST_NAME.test(host)) {
      throw new Error(`${where}: not an exact lowercase host name`);
    }
    if ((HOSTS as readonly string[]).includes(host) || host === HOSTEXEC_HOST) {
      throw new Error(`${where}: this host has a fixed policy`);
    }
    const rule = record(value, where);
    rejectUnknown(rule, ["credential"], where);
    if (rule.credential === undefined) {
      hosts[host] = {};
      continue;
    }
    const c = record(rule.credential, `${where}.credential`);
    rejectUnknown(c, ["env", "header", "scheme"], `${where}.credential`);
    const { env, header, scheme } = c;
    if (typeof env !== "string" || !ENV_NAME.test(env)) {
      throw new Error(`${where}.credential.env must be a variable name`);
    }
    if (RESERVED_ENV.has(env)) {
      throw new Error(
        `${where}.credential.env: ${env} belongs to another host`,
      );
    }
    if (envs.has(env)) {
      throw new Error(`${where}.credential.env: ${env} is used for two hosts`);
    }
    envs.add(env);
    if (
      typeof header !== "string" ||
      !HEADER_NAME.test(header) ||
      NOT_CREDENTIAL_HEADERS.has(header)
    ) {
      throw new Error(
        `${where}.credential.header must be a lowercase header name such as x-api-key or authorization`,
      );
    }
    if (
      scheme !== undefined &&
      (typeof scheme !== "string" || !SCHEME.test(scheme))
    ) {
      throw new Error(
        `${where}.credential.scheme must be a word such as Bearer`,
      );
    }
    hosts[host] = {
      credential: { env, header, ...(scheme === undefined ? {} : { scheme }) },
    };
  }
  return hosts;
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
