import type { BaseSessionEntry } from "../lib/runtime_registry.ts";
import {
  type AddForwardRequest,
  type AddForwardResult,
  copyManagedForward,
  type ForwardSelector,
  type ManagedForward,
  type RemoveForwardResult,
} from "./port_forward_model.ts";

export const PORT_BIND_PROTOCOL_VERSION = 2 as const;

/** One open host-port-to-container-port mapping. */
export interface PortBinding {
  containerPort: number;
  hostPort: number;
  /** ISO 8601, set when the listener opened. */
  createdAt: string;
}

/**
 * Outcome of the single dial the relay performs when a binding is created.
 * `container-not-running` and `relay-unreachable` describe why no dial was
 * attempted at all; the binding is created regardless.
 */
export type ProbeResult =
  | "ok"
  | "no-answer"
  | "container-not-running"
  | "relay-unreachable";

/**
 * One host-loopback port made reachable at `127.0.0.1:<containerPort>` inside
 * the container. The opposite direction from {@link PortBinding}: the
 * listener lives in the container and the host dials on its behalf.
 */
export interface PortForward {
  containerPort: number;
  hostPort: number;
  /** ISO 8601, set when the container listener came up. */
  createdAt: string;
}

/**
 * Whether the host port answered one dial when the forward was created. The
 * forward is kept either way; a host service started afterwards works too.
 */
export type HostProbeResult = "ok" | "no-answer";

/**
 * `brokerSocket` holds the control socket path, which gcRuntime probes.
 *
 * `forwards` is optional only on read: entries written before forwards
 * existed lack it. Use {@link sessionForwards} rather than the field.
 */
export interface PortBindSessionEntry extends BaseSessionEntry {
  /** Missing on sessions started before the common forwarding control wire. */
  protocolVersion?: typeof PORT_BIND_PROTOCOL_VERSION;
  bindings: PortBinding[];
  forwards?: PortForward[];
  /** Canonical state. Missing only in registries written by older sessions. */
  portForwards?: ManagedForward[];
}

export function sessionForwards(entry: PortBindSessionEntry): PortForward[] {
  return projectPortForwards(sessionPortForwards(entry)).forwards;
}

export function sessionPortForwards(
  entry: PortBindSessionEntry,
): ManagedForward[] {
  if (entry.portForwards !== undefined)
    return entry.portForwards.map(copyManagedForward);
  return [
    ...entry.bindings.map(
      (binding): ManagedForward => ({
        ...binding,
        direction: "local",
        owners: ["dynamic"],
        state: "active",
      }),
    ),
    ...(entry.forwards ?? []).map(
      (forward): ManagedForward => ({
        ...forward,
        direction: "remote",
        owners: ["dynamic"],
        state: "active",
      }),
    ),
  ].map(copyManagedForward);
}

export function projectPortForwards(entries: readonly ManagedForward[]): {
  bindings: PortBinding[];
  forwards: PortForward[];
} {
  const project = ({ containerPort, hostPort, createdAt }: ManagedForward) => ({
    containerPort,
    hostPort,
    createdAt,
  });
  return {
    bindings: entries
      .filter((entry) => entry.direction === "local")
      .map(project),
    forwards: entries
      .filter((entry) => entry.direction === "remote")
      .map(project),
  };
}

/**
 * Where a listener the relay saw is bound, seen from inside the container.
 *
 * The relay dials `127.0.0.1`, so only `any` and `loopback` can be reached
 * through a binding; the other two are reported so the UI can say *why* a
 * server it can see would not answer.
 */
export type ListenerScope = "any" | "loopback" | "loopback6" | "remote";

/** A container port the relay found in LISTEN state. */
export interface ObservedListener {
  containerPort: number;
  scope: ListenerScope;
}

/** An observed listener that no binding covers yet. */
export interface PortBindCandidate extends ObservedListener {
  /** False when a 127.0.0.1 dial from inside the container cannot reach it. */
  reachable: boolean;
}

/**
 * Whether the relay is currently reporting listeners. Watching starts only
 * once something asks for candidates, so a first request can answer
 * `watching` with an empty list while the first scan is still pending.
 */
export type ListenerWatchState =
  | "watching"
  | "container-not-running"
  | "relay-unreachable";

export type ControlRequest =
  | { type: "bind"; containerPort: number; hostPort: number | null }
  | { type: "unbind"; containerPort: number }
  | { type: "unbind"; hostPort: number }
  | { type: "candidates" }
  | { type: "forward"; containerPort: number; hostPort: number }
  | { type: "unforward"; containerPort: number }
  | ({ type: "add-forward" } & AddForwardRequest)
  | ({ type: "remove-forward" } & ForwardSelector);

export type ControlErrorKind =
  | "host-port-taken"
  | "binding-conflict"
  | "no-such-binding"
  | "invalid-request"
  /**
   * The relay could not listen on the container port: in use, privileged, or
   * one nas itself binds in the namespace.
   */
  | "container-port-taken"
  /** No relay to create the listener: container stopped or relay not startable. */
  | "relay-unavailable"
  /** Anything the broker did not anticipate; the UI turns it into a 500. */
  | "internal";

export type ControlResponse =
  | { ok: true; hostPort: number; probe: ProbeResult }
  | { ok: true; candidates: PortBindCandidate[]; watch: ListenerWatchState }
  | {
      ok: true;
      containerPort: number;
      hostPort: number;
      hostProbe: HostProbeResult;
    }
  | ({ ok: true } & AddForwardResult)
  | ({ ok: true } & RemoveForwardResult)
  | { ok: true }
  | { ok: false; error: ControlErrorKind; message: string };

/** A scope the relay can reach with its 127.0.0.1 dial. */
export function isReachableScope(scope: ListenerScope): boolean {
  return scope === "any" || scope === "loopback";
}

/** Both the control socket and the relay wire cap a line at this size. */
export const MAX_LINE_BYTES = 128;

/** Control socket requests and responses are JSON, so they get more room. */
export const MAX_CONTROL_BYTES = 8 * 1024;
