import type { PortBindKey, PortForwardKey } from "../domain/port_bind.ts";

const BIND_USAGE =
  "bind expects <session-id:container-port> [host-port] with ports from 1-65535";
const UNBIND_USAGE =
  "unbind expects [<session-id:container-port> | <host-port>] with ports from 1-65535";

function positionalArgs(args: string[], usage: string): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--runtime-dir" || arg === "--format") {
      if (index + 1 >= args.length) throw new Error(usage);
      index++;
      continue;
    }
    if (arg === "--format=json") continue;
    if (
      arg === "-q" ||
      arg === "--quiet" ||
      arg === "-v" ||
      arg === "--verbose"
    ) {
      continue;
    }
    if (arg.startsWith("-")) throw new Error(usage);
    positional.push(arg);
  }
  return positional;
}

function parsePort(value: string, usage: string): number {
  if (!/^\d+$/.test(value)) throw new Error(usage);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(usage);
  }
  return port;
}

function parseSessionKey(
  value: string,
  usage: string,
): {
  sessionId: string;
  containerPort: number;
} {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) throw new Error(usage);
  return {
    sessionId: value.slice(0, separator),
    containerPort: parsePort(value.slice(separator + 1), usage),
  };
}

export function parseBindArgs(args: string[]): {
  sessionId: string;
  containerPort: number;
  hostPort: number | null;
} {
  const positional = positionalArgs(args, BIND_USAGE);
  if (positional.length < 1 || positional.length > 2) {
    throw new Error(BIND_USAGE);
  }
  return {
    ...parseSessionKey(positional[0], BIND_USAGE),
    hostPort:
      positional.length === 2 ? parsePort(positional[1], BIND_USAGE) : null,
  };
}

/**
 * `bind <session>` with no container port. The user is asking what the
 * container is listening on rather than naming a target, so the caller offers
 * the detected ports instead of failing on the missing port.
 *
 * A bare number stays a usage error: `bind 3000` is a mistyped target, not a
 * session named "3000".
 */
export function parseBindSessionOnly(args: string[]): string | null {
  const positional = positionalArgs(args, BIND_USAGE);
  if (positional.length !== 1) return null;
  const value = positional[0];
  if (value.includes(":") || /^\d+$/.test(value)) return null;
  return value;
}

export function parseUnbindArgs(args: string[]): PortBindKey | null {
  const positional = positionalArgs(args, UNBIND_USAGE);
  if (positional.length === 0) return null;
  if (positional.length > 1) throw new Error(UNBIND_USAGE);
  if (positional[0].includes(":")) {
    return parseSessionKey(positional[0], UNBIND_USAGE);
  }
  return { hostPort: parsePort(positional[0], UNBIND_USAGE) };
}

const FORWARD_USAGE =
  "forward expects <session-id:container-port> [host-port] with ports from 1-65535";
const UNFORWARD_USAGE =
  "unforward expects [<session-id:container-port>] with ports from 1-65535";

/**
 * `forward <sid>:<cport> [hport]`. The key names the port inside the
 * container, as for bind; the host port defaults to the same number.
 */
export function parseForwardArgs(args: string[]): {
  sessionId: string;
  containerPort: number;
  hostPort: number;
} {
  const positional = positionalArgs(args, FORWARD_USAGE);
  if (positional.length < 1 || positional.length > 2) {
    throw new Error(FORWARD_USAGE);
  }
  const key = parseSessionKey(positional[0], FORWARD_USAGE);
  return {
    ...key,
    hostPort:
      positional.length === 2
        ? parsePort(positional[1], FORWARD_USAGE)
        : key.containerPort,
  };
}

/** `forward <session>` with no port: offer what the host is listening on. */
export function parseForwardSessionOnly(args: string[]): string | null {
  const positional = positionalArgs(args, FORWARD_USAGE);
  if (positional.length !== 1) return null;
  const value = positional[0];
  if (value.includes(":") || /^\d+$/.test(value)) return null;
  return value;
}

/**
 * A bare host port is not a key here: several sessions may forward the same
 * host port, so the number alone names nothing.
 */
export function parseUnforwardArgs(args: string[]): PortForwardKey | null {
  const positional = positionalArgs(args, UNFORWARD_USAGE);
  if (positional.length === 0) return null;
  if (positional.length > 1 || !positional[0].includes(":")) {
    throw new Error(UNFORWARD_USAGE);
  }
  return parseSessionKey(positional[0], UNFORWARD_USAGE);
}
