/**
 * Which ports the host itself is listening on, read from `/proc/net/tcp{,6}`.
 *
 * This is the host-side twin of the scan `port-relay.mjs` runs inside the
 * container: same files, same parse, same exclusions. It feeds the picker
 * behind `nas network forward <session>` so the user chooses from what is
 * actually there rather than typing a number.
 */

import { readFile } from "node:fs/promises";
import type { ListenerScope, ObservedListener } from "./port_bind_protocol.ts";

const LISTEN_STATE = "0A";
/** Higher wins when the same port is bound on several addresses. */
const SCOPE_RANK: Record<ListenerScope, number> = {
  any: 3,
  loopback: 2,
  loopback6: 1,
  remote: 0,
};
/** Used when the kernel's range is unreadable; the usual Linux default. */
const DEFAULT_EPHEMERAL_RANGE: readonly [number, number] = [32_768, 60_999];

/**
 * A forward dials `127.0.0.1` on the host, so only listeners on loopback or on
 * every address can be reached through one.
 */
export function isForwardableScope(scope: ListenerScope): boolean {
  return scope === "any" || scope === "loopback";
}

/**
 * Listening TCP ports on this host, outside the kernel's ephemeral range.
 * Ports the kernel handed out on its own were not asked for by a person, so
 * offering them would bury the one the user started.
 */
export async function readHostListeners(
  procDir = "/proc",
): Promise<ObservedListener[]> {
  const ephemeral = await readEphemeralRange(procDir);
  const found = new Map<number, ListenerScope>();
  await collect(`${procDir}/net/tcp`, ipv4Scope, ephemeral, found);
  await collect(`${procDir}/net/tcp6`, ipv6Scope, ephemeral, found);
  return [...found.entries()]
    .map(([containerPort, scope]) => ({ containerPort, scope }))
    .sort((a, b) => a.containerPort - b.containerPort);
}

async function readEphemeralRange(
  procDir: string,
): Promise<readonly [number, number]> {
  let text: string;
  try {
    text = await readFile(
      `${procDir}/sys/net/ipv4/ip_local_port_range`,
      "utf8",
    );
  } catch {
    return DEFAULT_EPHEMERAL_RANGE;
  }
  const [low, high] = text.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(low) || !Number.isInteger(high) || low > high) {
    return DEFAULT_EPHEMERAL_RANGE;
  }
  return [low, high];
}

async function collect(
  file: string,
  scopeOf: (hex: string) => ListenerScope | null,
  ephemeral: readonly [number, number],
  into: Map<number, ListenerScope>,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== LISTEN_STATE) continue;
    const separator = fields[1].lastIndexOf(":");
    if (separator <= 0) continue;
    const port = Number.parseInt(fields[1].slice(separator + 1), 16);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (port >= ephemeral[0] && port <= ephemeral[1]) continue;
    const scope = scopeOf(fields[1].slice(0, separator).toUpperCase());
    if (scope === null) continue;
    const known = into.get(port);
    if (known === undefined || SCOPE_RANK[scope] > SCOPE_RANK[known]) {
      into.set(port, scope);
    }
  }
}

// /proc prints each 4-byte word of the address in host order, so 127.0.0.1
// arrives as "0100007F" and the first octet is the low byte.
function ipv4Scope(hex: string): ListenerScope | null {
  if (!/^[0-9A-F]{8}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  if (value === 0) return "any";
  return (value & 0xff) === 127 ? "loopback" : "remote";
}

function ipv6Scope(hex: string): ListenerScope | null {
  if (!/^[0-9A-F]{32}$/.test(hex)) return null;
  const words = [0, 1, 2, 3].map((index) =>
    hex.slice(index * 8, index * 8 + 8),
  );
  if (words.every((word) => word === "00000000")) return "any";
  const zeroPrefix = words[0] === "00000000" && words[1] === "00000000";
  // ::ffff:a.b.c.d — the mapped v4 address decides reachability.
  if (zeroPrefix && words[2] === "FFFF0000") return ipv4Scope(words[3]);
  if (zeroPrefix && words[2] === "00000000" && words[3] === "01000000") {
    return "loopback6";
  }
  return "remote";
}
