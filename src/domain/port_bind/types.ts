export type PortBindKey =
  | { readonly sessionId: string; readonly containerPort: number }
  | { readonly hostPort: number };

/**
 * A forward is keyed by the container port alone: several sessions may
 * forward the same host port, so a bare host port names nothing.
 */
export interface PortForwardKey {
  readonly sessionId: string;
  readonly containerPort: number;
}

export class ContainerPortTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerPortTakenError";
  }
}

export class RelayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayUnavailableError";
  }
}

export class HostPortTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostPortTakenError";
  }
}

export class BindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingConflictError";
  }
}

export class NoSuchBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSuchBindingError";
  }
}

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export class InternalBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalBrokerError";
  }
}

export class SessionUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionUnreachableError";
  }
}

export class AmbiguousHostPortError extends Error {
  constructor(hostPort: number, sessionIds: string[]) {
    super(
      `host port ${hostPort} is claimed by ${sessionIds.join(", ")}; run nas network gc`,
    );
    this.name = "AmbiguousHostPortError";
  }
}
