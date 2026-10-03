import { type OutgoingHttpHeaders, validateHeaderValue } from "node:http";
import type { StraitConfig } from "./config.ts";
import { ANTHROPIC_HOST, GITHUB_API_HOST, GITHUB_HOST } from "./policy.ts";

/** Availability and selected header names only: safe to pass to policy. */
export type CredentialHeaders = Readonly<Record<string, string>>;

/** Library-only extension; strait.json never exposes srt credentials. */
export interface CredentialOverwrite {
  overwriteHeaders(headers: OutgoingHttpHeaders, destinationHost: string): void;
}

/** Keep secret-bearing values in this closure, outside policy and approvals. */
export function buildCredentials(
  hosts: StraitConfig["hosts"],
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const byHost = new Map<string, { header: string; value: string }>();
  const masked = new Map<string, string>();
  const policyHeaders: Record<string, string> = Object.create(null);
  const put = (host: string, header: string, value: string) => {
    try {
      validateHeaderValue(header, value);
    } catch {
      throw new Error("invalid host credential header value");
    }
    byHost.set(host, { header, value });
    policyHeaders[host] = header;
  };
  const gh = env.GH_TOKEN;
  const gitAuthorization = gh
    ? `Basic ${Buffer.from(`x-access-token:${gh}`).toString("base64")}`
    : undefined;
  if (gh && gitAuthorization) {
    masked.set("GH_TOKEN", gh);
    masked.set("STRAIT_GIT_AUTH", gitAuthorization);
    put(GITHUB_API_HOST, "authorization", `Bearer ${gh}`);
    put(GITHUB_HOST, "authorization", gitAuthorization);
  }
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;
  const key = env.ANTHROPIC_API_KEY;
  if (oauth) masked.set("CLAUDE_CODE_OAUTH_TOKEN", oauth);
  if (key) masked.set("ANTHROPIC_API_KEY", key);
  if (oauth) put(ANTHROPIC_HOST, "authorization", `Bearer ${oauth}`);
  else if (key) put(ANTHROPIC_HOST, "x-api-key", key);
  for (const [host, rule] of Object.entries(hosts)) {
    const c = rule.credential;
    if (!c) continue;
    const value = env[c.env];
    if (!value)
      throw new Error(`hosts.${host}.credential.env: ${c.env} is not set`);
    masked.set(c.env, value);
    put(host, c.header, c.scheme ? `${c.scheme} ${value}` : value);
  }
  return {
    policyHeaders: policyHeaders as CredentialHeaders,
    gitAuthorization,
    maskedEnvVars: [...masked.keys()].map((name) => ({
      name,
      mode: "mask" as const,
      injectHosts: [] as string[],
    })),
    // Preserve hostexec output masking, including the encoded Basic value.
    secrets: [...masked.values()].flatMap((v) =>
      v.startsWith("Basic ") ? [v, v.slice(6)] : [v],
    ),
    overwrite(headers: OutgoingHttpHeaders, destinationHost: string): void {
      delete headers.authorization;
      delete headers["x-api-key"];
      const credential = byHost.get(destinationHost);
      if (credential) {
        delete headers[credential.header];
        headers[credential.header] = credential.value;
      }
    },
    assertMasked(entries: Iterable<[string, string]>): void {
      // A multiset retains the number of separately masked names even when
      // several environment variables hold the same secret.
      const registered = new Map<string, number>();
      for (const [, real] of entries)
        registered.set(real, (registered.get(real) ?? 0) + 1);
      const missing: [string, string][] = [];
      for (const entry of masked) {
        const remaining = registered.get(entry[1]) ?? 0;
        if (!remaining) missing.push(entry);
        else registered.set(entry[1], remaining - 1);
      }
      if (missing.length)
        throw new Error(
          `srt did not mask ${missing.map(([name]) => name).join(", ")}`,
        );
    },
  };
}
