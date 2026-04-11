import { isIP } from "node:net";

export type ApprovalScope = "once" | "host-port" | "host";
export type RequestKind = "connect" | "forward";
export type Decision = "allow" | "deny";

export interface SessionCredentials {
  sessionId: string;
  token: string;
}

export interface NormalizedTarget {
  host: string;
  port: number;
}

export interface AuthorizeRequest {
  version: 1;
  type: "authorize";
  requestId: string;
  sessionId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  observedAt: string;
}

export interface DecisionResponse {
  version: 1;
  type: "decision";
  requestId: string;
  decision: Decision;
  scope?: ApprovalScope;
  reason: string;
  message?: string;
}

export interface PendingEntry {
  version: 1;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  state: "pending";
  createdAt: string;
  updatedAt: string;
}

export interface SessionRegistryEntry {
  version: 1;
  sessionId: string;
  tokenHash: string;
  brokerSocket: string;
  profileName: string;
  allowlist: string[];
  createdAt: string;
  pid: number;
  promptEnabled: boolean;
  agent?: string;
}

export interface NormalizeTargetInput {
  method: string;
  authority?: string | null;
  url?: string | null;
  hostHeader?: string | null;
}

export function generateSessionId(): string {
  return `sess_${randomHex(6)}`;
}

export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export function decodeProxyAuthorization(
  header: string | null | undefined,
): SessionCredentials | null {
  if (!header) return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1].trim());
    const idx = decoded.indexOf(":");
    if (idx <= 0 || idx === decoded.length - 1) {
      return null;
    }
    return {
      sessionId: decoded.slice(0, idx),
      token: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

export function normalizeTarget(input: NormalizeTargetInput): NormalizedTarget {
  const method = input.method.toUpperCase();
  if (method === "CONNECT") {
    const authority = parseAuthority(input.authority ?? input.hostHeader ?? "");
    if (authority.port === null) {
      throw new Error("CONNECT target must include an explicit port");
    }
    return {
      host: normalizeHost(authority.host),
      port: authority.port,
    };
  }

  if (input.url) {
    try {
      const url = new URL(input.url);
      return {
        host: normalizeHost(url.hostname),
        port: Number(url.port || defaultPortForScheme(url.protocol)),
      };
    } catch {
      // Fall through to Host/:authority parsing.
    }
  }

  const authority = parseAuthority(input.authority ?? input.hostHeader ?? "");
  return {
    host: normalizeHost(authority.host),
    port: authority.port ?? 80,
  };
}

export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  while (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  if (value.length === 0) {
    throw new Error("host must not be empty");
  }
  return value;
}

/**
 * Parses an allowlist/denylist entry into its host and optional port parts.
 * Supports: "example.com", "example.com:443", "*.example.com", "*.example.com:443",
 * "[::1]", "[::1]:8080"
 */
export function parseAllowlistEntry(entry: string): {
  host: string;
  port: number | null;
} {
  const withoutWildcard = entry.startsWith("*.") ? entry.slice(2) : entry;
  const wildcardPrefix = entry.startsWith("*.") ? "*." : "";

  if (withoutWildcard.startsWith("[")) {
    const end = withoutWildcard.indexOf("]");
    if (end === -1) throw new Error(`invalid entry: ${entry}`);
    const host = wildcardPrefix + withoutWildcard.slice(0, end + 1);
    const rest = withoutWildcard.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) throw new Error(`invalid entry: ${entry}`);
    return { host, port: parsePort(rest.slice(1)) };
  }

  const colonIdx = withoutWildcard.lastIndexOf(":");
  if (colonIdx <= 0) return { host: entry, port: null };

  // Check if everything after the last colon looks like a port number.
  // If not, treat the whole thing as a host (e.g., bare IPv6 without brackets).
  const maybePart = withoutWildcard.slice(colonIdx + 1);
  if (!/^\d+$/.test(maybePart)) return { host: entry, port: null };

  const port = parsePort(maybePart);
  const hostPart = withoutWildcard.slice(0, colonIdx);
  return { host: wildcardPrefix + hostPart, port };
}

export function matchesAllowlist(
  target: NormalizedTarget,
  allowlist: string[],
): boolean {
  const normalizedHost = normalizeHost(target.host);
  return allowlist.some((entry) => {
    const parsed = parseAllowlistEntry(entry);
    // If the entry specifies a port, both host and port must match.
    if (parsed.port !== null && parsed.port !== target.port) return false;
    const hostEntry = parsed.host;
    const candidate = normalizeHost(
      hostEntry.startsWith("*.") ? hostEntry.slice(2) : hostEntry,
    );
    if (hostEntry.startsWith("*.")) {
      return (
        normalizedHost === candidate || normalizedHost.endsWith(`.${candidate}`)
      );
    }
    return normalizedHost === candidate;
  });
}

export function targetKey(target: NormalizedTarget): string {
  return `${target.host}:${target.port}`;
}

export function targetKeyForScope(
  target: NormalizedTarget,
  scope: ApprovalScope,
): string {
  if (scope === "host") return target.host;
  return targetKey(target);
}

export function denyReasonForTarget(target: NormalizedTarget): string | null {
  const host = normalizeHost(target.host);
  if (host === "localhost") {
    return "blocked-special-host";
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    if (isDeniedIpv4(host)) return "blocked-private-ip";
    return null;
  }
  if (ipVersion === 6) {
    if (isDeniedIpv6(host)) return "blocked-private-ip";
    return null;
  }
  return null;
}

function parseAuthority(authority: string): {
  host: string;
  port: number | null;
} {
  const value = authority.trim();
  if (value.length === 0) {
    throw new Error("authority is required");
  }

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      throw new Error("invalid IPv6 authority");
    }
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) {
      throw new Error("invalid IPv6 authority");
    }
    return { host, port: parsePort(rest.slice(1)) };
  }

  const colonIdx = value.lastIndexOf(":");
  if (
    colonIdx <= 0 ||
    (value.includes(":") && value.indexOf(":") !== colonIdx)
  ) {
    return { host: value, port: null };
  }
  return {
    host: value.slice(0, colonIdx),
    port: parsePort(value.slice(colonIdx + 1)),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

function defaultPortForScheme(protocol: string): number {
  if (protocol === "https:") return 443;
  return 80;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isDeniedIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isDeniedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  const first = normalized.split(":")[0];
  if (first.length === 0) return false;
  const value = Number.parseInt(first, 16);
  if (Number.isNaN(value)) return false;
  // fc00::/7  — ULA (unique local address)
  if ((value & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((value & 0xffc0) === 0xfe80) return true;
  return false;
}
