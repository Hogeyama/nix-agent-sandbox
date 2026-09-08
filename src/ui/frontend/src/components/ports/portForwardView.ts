import type {
  AddForwardResult,
  ManagedForward,
  RemoveForwardResult,
} from "../../../../../network/port_forward_model";
import type { PortBindSessionLike } from "../../stores/types";

export type ForwardRow = {
  directionLabel: "Local" | "Remote";
  listenLabel: string;
  targetLabel: string;
  href: string | null;
  ownerLabel: string;
  stateLabel: string;
};

export function forwardRow(entry: ManagedForward): ForwardRow {
  const local = entry.direction === "local";
  return {
    directionLabel: local ? "Local" : "Remote",
    listenLabel: local
      ? `host localhost:${entry.hostPort}`
      : `container localhost:${entry.containerPort}`,
    targetLabel: local
      ? `container localhost:${entry.containerPort}`
      : `host localhost:${entry.hostPort}`,
    href: local ? `http://localhost:${entry.hostPort}` : null,
    ownerLabel: entry.owners.join(", "),
    stateLabel:
      entry.state === "failed" && entry.error
        ? `failed — ${entry.error}`
        : entry.state,
  };
}

export function addForwardNotice(result: AddForwardResult): string | null {
  if (result.probe === "ok") return null;
  if (result.probe === "no-answer") {
    const side = result.entry.direction === "local" ? "container" : "host";
    const port =
      result.entry.direction === "local"
        ? result.entry.containerPort
        : result.entry.hostPort;
    return `Target probe: no answer from ${side} 127.0.0.1:${port} yet`;
  }
  if (result.probe === "container-not-running") {
    return "Target probe: the container is not running";
  }
  return "Target probe: the container relay is unavailable";
}

export function removeForwardNotice(result: RemoveForwardResult): string {
  if (result.retainedInternal) {
    return result.removed
      ? "User ownership removed. Internal forwarding remains and its listener stayed open."
      : "No user ownership was removed. Internal forwarding remains and its listener stayed open.";
  }
  if (!result.removed) {
    return "No user-owned forwarding matched. The listener was not closed.";
  }
  return result.listenerClosed
    ? "Forward removed and its listener closed."
    : "Forward removed, but listener closure was not confirmed.";
}

export function sessionForwardRows(
  entry: PortBindSessionLike,
): ManagedForward[] {
  if (entry.portForwards !== undefined) return entry.portForwards;
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
  ];
}
