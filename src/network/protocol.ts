export type ApprovalScope = "once" | "host-port" | "host";

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
  requestKind: "connect" | "forward";
  observedAt: string;
}

export interface DecisionResponse {
  version: 1;
  type: "decision";
  requestId: string;
  decision: "allow" | "deny";
  scope?: ApprovalScope;
  reason?: string;
  message?: string;
}

export interface PendingEntry {
  version: 1;
  requestId: string;
  sessionId: string;
  target: NormalizedTarget;
  state: "pending" | "approved" | "denied" | "timed-out";
  createdAt: string;
  updatedAt: string;
  scope?: ApprovalScope;
  reason?: string;
}

export interface SessionRegistryEntry {
  version: 1;
  sessionId: string;
  tokenHash: string;
  brokerSocket: string;
  profileName: string;
  allowlist: string[];
  promptEnabled: boolean;
  createdAt: string;
  pid: number;
}

export interface NormalizeTargetInput {
  method: string;
  url?: string | null;
  authority?: string | null;
  host?: string | null;
  scheme?: string | null;
}

const LOCALHOST_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
]);

export function decodeProxyAuthorization(
  header: string | null | undefined,
): SessionCredentials | null {
  if (!header) return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  let decoded: string;
  try {
    decoded = atob(match[1].trim());
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator <= 0 || separator === decoded.length - 1) {
    return null;
  }

  return {
    sessionId: decoded.slice(0, separator),
    token: decoded.slice(separator + 1),
  };
}

export function normalizeTarget(
  input: NormalizeTargetInput,
): NormalizedTarget | null {
  if (input.method.toUpperCase() === "CONNECT") {
    return normalizeAuthorityTarget(input.authority);
  }

  const absoluteTarget = normalizeAbsoluteUrlTarget(input.url);
  if (absoluteTarget) {
    return absoluteTarget;
  }

  return normalizeAuthorityTarget(
    firstNonEmpty(input.host, input.authority),
    normalizeScheme(input.scheme) ?? "http",
  );
}

export function isDenyByDefaultTarget(target: NormalizedTarget): boolean {
  if (LOCALHOST_HOSTS.has(target.host)) {
    return true;
  }

  const ipv4 = parseIpv4(target.host);
  if (ipv4) {
    return isDeniedIpv4(ipv4);
  }

  const ipv6 = parseIpv6(target.host);
  if (ipv6) {
    return isDeniedIpv6(ipv6);
  }

  return false;
}

function normalizeAbsoluteUrlTarget(
  rawUrl?: string | null,
): NormalizedTarget | null {
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = normalizeHost(url.hostname);
  if (!host) return null;

  const scheme = normalizeScheme(url.protocol.slice(0, -1));
  const port = parsePort(url.port) ?? defaultPortForScheme(scheme);
  if (!port) return null;

  return { host, port };
}

function normalizeAuthorityTarget(
  authority: string | null | undefined,
  scheme?: string,
): NormalizedTarget | null {
  if (!authority || authority.trim() === "") return null;
  const trimmedAuthority = authority.trim();
  if (/[\s/?#@]/.test(trimmedAuthority)) {
    return null;
  }

  const parsed = parseAuthority(trimmedAuthority);
  if (!parsed) return null;

  const host = normalizeHost(parsed.host);
  if (!host) return null;

  const port = parsed.port !== undefined
    ? parsePort(parsed.port)
    : defaultPortForScheme(scheme);
  if (!port) return null;

  return { host, port };
}

function normalizeHost(rawHost: string): string | null {
  if (!rawHost) return null;

  let host = rawHost.trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "") {
    return null;
  }
  return host;
}

function normalizeScheme(rawScheme?: string | null): string | null {
  if (!rawScheme) return null;
  return rawScheme.trim().toLowerCase();
}

function defaultPortForScheme(scheme?: string | null): number | null {
  if (scheme === "http") return 80;
  if (scheme === "https") return 443;
  return null;
}

function parsePort(rawPort: string): number | null {
  if (rawPort === "") return null;
  if (!/^\d+$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function parseAuthority(
  authority: string,
): { host: string; port?: string } | null {
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing === -1) return null;
    const host = authority.slice(1, closing);
    const remainder = authority.slice(closing + 1);
    if (remainder === "") return { host };
    if (!remainder.startsWith(":")) return null;
    return { host, port: remainder.slice(1) };
  }

  const colonCount = authority.split(":").length - 1;
  if (colonCount > 1) {
    return null;
  }

  const lastColon = authority.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: authority };
  }

  return {
    host: authority.slice(0, lastColon),
    port: authority.slice(lastColon + 1),
  };
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (value && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }
  const octets = host.split(".").map((part) => Number(part));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets;
}

function isDeniedIpv4(octets: number[]): boolean {
  const [a, b, c, d] = octets;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254 && c === 169 && d === 254) return true;
  return false;
}

function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) {
    return null;
  }
  if (host.includes(":::")) {
    return null;
  }

  const [headRaw, tailRaw] = host.split("::");
  if (host.split("::").length > 2) {
    return null;
  }

  const head = parseIpv6Segments(headRaw);
  if (!head) return null;

  if (tailRaw === undefined) {
    return head.length === 8 ? head : null;
  }

  const tail = parseIpv6Segments(tailRaw);
  if (!tail) return null;

  const missing = 8 - (head.length + tail.length);
  if (missing < 1) {
    return null;
  }

  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function parseIpv6Segments(raw?: string): number[] | null {
  if (raw === undefined || raw === "") return [];
  const segments = raw.split(":");
  const parsed: number[] = [];

  for (const segment of segments) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return null;
    }
    parsed.push(Number.parseInt(segment, 16));
  }

  return parsed;
}

function isDeniedIpv6(segments: number[]): boolean {
  if (segments.length !== 8) return false;
  if (segments.every((segment, index) => segment === (index === 7 ? 1 : 0))) {
    return true;
  }

  const first = segments[0];
  if ((first & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((first & 0xfe00) === 0xfc00) {
    return true;
  }

  return false;
}
