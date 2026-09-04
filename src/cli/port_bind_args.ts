import type { PortBindKey } from "../domain/port_bind.ts";

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

export function parseUnbindArgs(args: string[]): PortBindKey | null {
  const positional = positionalArgs(args, UNBIND_USAGE);
  if (positional.length === 0) return null;
  if (positional.length > 1) throw new Error(UNBIND_USAGE);
  if (positional[0].includes(":")) {
    return parseSessionKey(positional[0], UNBIND_USAGE);
  }
  return { hostPort: parsePort(positional[0], UNBIND_USAGE) };
}
