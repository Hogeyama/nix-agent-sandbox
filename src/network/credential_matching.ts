import type { InjectHeader, ResolvedCredential } from "./protocol.ts";
import {
  matchesHostPattern,
  normalizeHost,
  parseAllowlistEntry,
} from "./protocol.ts";

export function findMatchingCredentials(
  credentials: ResolvedCredential[],
  host: string,
  port: number,
  method: string,
  path: string,
): InjectHeader[] {
  const headers: InjectHeader[] = [];
  const target = { host: normalizeHost(host), port };

  for (const cred of credentials) {
    if (!matchesHostPattern(target, [cred.host])) continue;
    // If cred.host has no explicit port, default to HTTPS-only (port 443)
    // to prevent credential leakage over plaintext HTTP connections.
    // Users who need a non-standard port can specify it explicitly (e.g. "api.example.com:8443").
    const parsedHost = parseAllowlistEntry(cred.host);
    if (parsedHost.port === null && port !== 443) continue;
    if (
      cred.method !== undefined &&
      cred.method.toUpperCase() !== method.toUpperCase()
    )
      continue;
    if (cred.pathPrefix !== undefined && !path.startsWith(cred.pathPrefix))
      continue;
    headers.push({ name: cred.header, value: cred.value });
  }

  return headers;
}
