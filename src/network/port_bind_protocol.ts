import type { BaseSessionEntry } from "../lib/runtime_registry.ts";

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

/** `brokerSocket` holds the control socket path, which gcRuntime probes. */
export interface PortBindSessionEntry extends BaseSessionEntry {
  bindings: PortBinding[];
}

export type ControlRequest =
  | { type: "bind"; containerPort: number; hostPort: number | null }
  | { type: "unbind"; containerPort: number }
  | { type: "unbind"; hostPort: number };

export type ControlErrorKind =
  | "host-port-taken"
  | "binding-conflict"
  | "no-such-binding"
  | "invalid-request"
  /** Anything the broker did not anticipate; the UI turns it into a 500. */
  | "internal";

export type ControlResponse =
  | { ok: true; hostPort: number; probe: ProbeResult }
  | { ok: true }
  | { ok: false; error: ControlErrorKind; message: string };

/** Both the control socket and the relay wire cap a line at this size. */
export const MAX_LINE_BYTES = 128;

/** Control socket requests and responses are JSON, so they get more room. */
export const MAX_CONTROL_BYTES = 8 * 1024;
