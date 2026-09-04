# Container Port Bind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user open a TCP port that an agent's server listens on inside its container, on the host's loopback, on demand, for a running session.

**Architecture:** The session's host-side `nas` process owns a Unix socket that is bind-mounted read-only into the agent container. A relay process, started inside the container on first use, connects outward to that socket: one control connection carries requests, and each browser connection is paired with a fresh stream connection by a single-use random id. The host holds one `127.0.0.1` TCP listener per binding and pipes bytes between it and the paired stream.

**Tech Stack:** Bun, TypeScript (strict), Effect (stages and services), `node:net`, Docker CLI.

**Spec:** `docs/superpowers/specs/2026-09-04-container-port-bind-design.md`. Read it before starting; this plan implements it and does not restate its rationale.

## Global Constraints

- Runtime is Bun with `bun:test`. There is no Deno API in this repository.
- Type check with `bun run check`; it runs in strict mode.
- Unit tests are `*_test.ts` next to their source. Docker-dependent tests MUST end in `integration_test.ts` or they poison the unit lane. Iterate with `bun run test:unit`; run the full `bun run test` exactly once, at the end.
- Effect service tiers are defined in `.claude/skills/effect-separation/SKILL.md` and `references/domain-service.md`. L2 domain services use Tag `"nas/<Name>Service"`, an error channel of `Error` (never `Data.TaggedError`), pure types in `types.ts`, and a `makeXxxClient()` plain-async adapter that closes `R`.
- A stage's `run()` may only call pure planners and service methods. No `node:fs`, no `Bun.spawn`, no Docker CLI calls in a stage body.
- Format and lint with Biome: `bunx biome check --write <paths>` before each commit.
- Every commit message follows the repository's conventional-commit style and ends with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.
- Comments describe the code as it will be read a year from now. Never write a comment about what this change altered.

## File Structure

| File | Responsibility |
|---|---|
| `src/network/port_bind_protocol.ts` | Pure wire and registry types shared by host, CLI and UI. Mirrors `src/network/protocol.ts`. |
| `src/network/port_bind_registry.ts` | Ports runtime paths, session entry read/write, host-port lookup. Thin layer over `src/lib/runtime_registry.ts`. |
| `src/network/port_bind_relay.ts` | Host side of the relay wire protocol: the UDS listener, first-line framing, id pairing, socket piping. |
| `src/network/port_bind_supervisor.ts` | The "is the relay alive, should I exec it again" state machine, with an injected exec seam. |
| `src/network/port_bind_broker.ts` | Control socket server, TCP listeners per binding, registry writes. |
| `src/docker/embed/port-relay.mjs` | Container side: connects outward, dials `127.0.0.1:<port>`, pipes. |
| `src/stages/port_bind/stage.ts` | Pure planner returning the two file mounts, plus the stage orchestrator. |
| `src/stages/port_bind/port_bind_service.ts` | L3-a service owning the socket, the script copy and the broker lifetime. |
| `src/stages/port_bind.ts` | Barrel. |
| `src/domain/port_bind/types.ts` | Typed errors for the plain-async boundary. |
| `src/domain/port_bind/service.ts` | L2 service and `makePortBindClient()`, shared by CLI and UI. |
| `src/domain/port_bind.ts` | Barrel. |
| `src/cli/port_bind_args.ts` | Argument parsing for `bind` / `unbind`. |

---

### Task 1: Wire and registry types, ports runtime paths

**Files:**
- Create: `src/network/port_bind_protocol.ts`
- Create: `src/network/port_bind_registry.ts`
- Test: `src/network/port_bind_registry_test.ts`

**Interfaces:**
- Consumes: `BaseRuntimePaths`, `BaseSessionEntry`, `sessionRegistryPath`, `writeSessionRegistry`, `readSessionRegistry`, `listSessionRegistries`, `brokerSocketPath`, `sessionBrokerDir`, `gcRuntime` from `src/lib/runtime_registry.ts`; `defaultRuntimeDir`, `ensureDir` from `src/lib/fs_utils.ts`.
- Produces: `PortBinding`, `ProbeResult`, `PortBindSessionEntry`, `ControlRequest`, `ControlResponse`, `PortsRuntimePaths`, `portsRuntimeDir()`, `resolvePortsRuntimePaths()`, `relaySocketPath()`, `relayScriptPath()`, `listPortBindSessions()`, `findSessionsByHostPort()`.

`defaultRuntimeDir("ports")` (`src/lib/fs_utils.ts:132`) and `portsRuntimeDir`
must agree: the first uses `userInfo().uid`, the second takes the uid the stage
probed. `resolvePortsRuntimePaths()` keeps `defaultRuntimeDir` as its default so
the CLI needs no host probe, and the stage passes an explicit directory built
with `portsRuntimeDir`. A session whose `host.uid` is null and whose
`XDG_RUNTIME_DIR` is unset would otherwise write to `/tmp/nas-unknown/ports`
while the CLI reads `/tmp/nas-1000/ports`.

- [ ] **Step 1: Write the failing test**

Create `src/network/port_bind_registry_test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeSessionRegistry } from "../lib/runtime_registry.ts";
import type { PortBindSessionEntry } from "./port_bind_protocol.ts";
import {
  findSessionsByHostPort,
  listPortBindSessions,
  portsRuntimeDir,
  relayScriptPath,
  relaySocketPath,
  resolvePortsRuntimePaths,
} from "./port_bind_registry.ts";

async function withPaths<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "nas-ports-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function entry(
  sessionId: string,
  bindings: PortBindSessionEntry["bindings"],
): PortBindSessionEntry {
  return {
    sessionId,
    pid: process.pid,
    brokerSocket: `/nonexistent/${sessionId}/sock`,
    bindings,
  };
}

test("portsRuntimeDir prefers XDG_RUNTIME_DIR and falls back to the uid", () => {
  expect(portsRuntimeDir("/run/user/1000", 1000)).toEqual(
    "/run/user/1000/nas/ports",
  );
  expect(portsRuntimeDir(undefined, 1000)).toEqual("/tmp/nas-1000/ports");
  expect(portsRuntimeDir("   ", 1000)).toEqual("/tmp/nas-1000/ports");
});

test("resolvePortsRuntimePaths derives every subdirectory from the root", async () => {
  await withPaths(async (root) => {
    const paths = await resolvePortsRuntimePaths(root);
    expect(paths.runtimeDir).toEqual(root);
    expect(paths.sessionsDir).toEqual(path.join(root, "sessions"));
    expect(paths.brokersDir).toEqual(path.join(root, "brokers"));
    expect(relaySocketPath(paths, "s1")).toEqual(
      path.join(root, "brokers", "s1", "relay.sock"),
    );
    expect(relayScriptPath(paths)).toEqual(
      path.join(root, "relay", "port-relay.mjs"),
    );
  });
});

test("listPortBindSessions returns written entries with their bindings", async () => {
  await withPaths(async (root) => {
    const paths = await resolvePortsRuntimePaths(root);
    await writeSessionRegistry(
      paths,
      entry("s1", [{ containerPort: 3000, hostPort: 3000, createdAt: "t" }]),
    );
    const listed = await listPortBindSessions(paths);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.bindings[0]?.hostPort).toEqual(3000);
  });
});

test("findSessionsByHostPort matches on host port and returns every claimant", async () => {
  await withPaths(async (root) => {
    const paths = await resolvePortsRuntimePaths(root);
    await writeSessionRegistry(
      paths,
      entry("s1", [{ containerPort: 3000, hostPort: 8080, createdAt: "t" }]),
    );
    await writeSessionRegistry(
      paths,
      entry("s2", [{ containerPort: 5173, hostPort: 8080, createdAt: "t" }]),
    );
    await writeSessionRegistry(
      paths,
      entry("s3", [{ containerPort: 5173, hostPort: 9090, createdAt: "t" }]),
    );
    const matches = await findSessionsByHostPort(paths, 8080);
    expect(matches.map((m) => m.sessionId).sort()).toEqual(["s1", "s2"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/network/port_bind_registry_test.ts`
Expected: FAIL — `Cannot find module './port_bind_registry.ts'`.

- [ ] **Step 3: Write the protocol types**

Create `src/network/port_bind_protocol.ts`:

```ts
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
```

- [ ] **Step 4: Write the registry module**

Create `src/network/port_bind_registry.ts`:

```ts
import * as path from "node:path";
import { defaultRuntimeDir, ensureDir } from "../lib/fs_utils.ts";
import {
  type BaseRuntimePaths,
  listSessionRegistries,
  sessionBrokerDir,
} from "../lib/runtime_registry.ts";
import type { PortBindSessionEntry } from "./port_bind_protocol.ts";

export {
  brokerSocketPath,
  readSessionRegistry,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../lib/runtime_registry.ts";

export interface PortsRuntimePaths extends BaseRuntimePaths {
  /** Directory holding the relay script that containers mount read-only. */
  relayDir: string;
}

/**
 * The session process and the CLI must agree on where the sockets live, and
 * they derive it from different sources — a stage has the probed host env, the
 * CLI has `process.env`. Both go through here so they cannot drift.
 */
export function portsRuntimeDir(
  xdgRuntimeDir: string | undefined,
  uid: number | string,
): string {
  if (xdgRuntimeDir && xdgRuntimeDir.trim().length > 0) {
    return path.join(xdgRuntimeDir, "nas", "ports");
  }
  return path.join("/tmp", `nas-${uid}`, "ports");
}

export async function resolvePortsRuntimePaths(
  runtimeDir?: string,
): Promise<PortsRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir("ports");
  const paths: PortsRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
    pendingDir: path.join(resolved, "pending"),
    brokersDir: path.join(resolved, "brokers"),
    relayDir: path.join(resolved, "relay"),
  };
  await ensureDir(paths.runtimeDir);
  await ensureDir(paths.sessionsDir);
  await ensureDir(paths.brokersDir);
  await ensureDir(paths.relayDir);
  return paths;
}

/**
 * The socket the container connects to. It sits beside the control socket in
 * the session's broker dir, and only this file is bind-mounted, so the control
 * socket stays invisible to the container.
 */
export function relaySocketPath(
  paths: BaseRuntimePaths,
  sessionId: string,
): string {
  return path.join(sessionBrokerDir(paths, sessionId), "relay.sock");
}

export function relayScriptPath(paths: PortsRuntimePaths): string {
  return path.join(paths.relayDir, "port-relay.mjs");
}

export function listPortBindSessions(
  paths: BaseRuntimePaths,
): Promise<PortBindSessionEntry[]> {
  return listSessionRegistries<PortBindSessionEntry>(paths);
}

/**
 * A host port names no session by itself. Every claimant is returned so the
 * caller can refuse an ambiguous match rather than guess.
 */
export async function findSessionsByHostPort(
  paths: BaseRuntimePaths,
  hostPort: number,
): Promise<PortBindSessionEntry[]> {
  const sessions = await listPortBindSessions(paths);
  return sessions.filter((session) =>
    session.bindings.some((binding) => binding.hostPort === hostPort),
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/network/port_bind_registry_test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Format, type check and commit**

```bash
bunx biome check --write src/network/port_bind_protocol.ts src/network/port_bind_registry.ts src/network/port_bind_registry_test.ts
bun run check
git add src/network/port_bind_protocol.ts src/network/port_bind_registry.ts src/network/port_bind_registry_test.ts
git commit -m "feat(port-bind): add ports runtime paths and registry types"
```

---

### Task 2: Host-side relay gateway

**Files:**
- Create: `src/network/port_bind_relay.ts`
- Test: `src/network/port_bind_relay_test.ts`

**Interfaces:**
- Consumes: `PortBinding`, `ProbeResult`, `MAX_LINE_BYTES` from Task 1.
- Produces: `readFirstLine(socket, maxBytes)`, `pipeSockets(a, b, opts?)`, `startRelayGateway(opts)` returning `RelayGateway` with `openStream(port)`, `probe(port)`, `isRelayConnected()`, `socketPath`, `close()`.

The gateway is the host end of the wire protocol in the spec. It listens on the
UDS, accepts the relay's `control` connection and its `stream <id>` connections,
issues ids, and pairs them. It knows nothing about TCP listeners or bindings.

- [ ] **Step 1: Write the failing tests**

Create `src/network/port_bind_relay_test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readFirstLine, startRelayGateway } from "./port_bind_relay.ts";

async function withSocketPath<T>(fn: (p: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-relay-"));
  try {
    return await fn(path.join(dir, "relay.sock"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `readFirstLine` leaves its socket paused, so every test that reads what
 * follows the line has to resume it. Production code resumes through `pipe()`.
 */
function firstChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk));
    socket.resume();
  });
}

/** Minimal stand-in for port-relay.mjs: dials a loopback port on request. */
function fakeRelay(socketPath: string, target: number) {
  const control = connect({ path: socketPath });
  control.write("control\n");
  control.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const [verb, id, port] = line.split(" ");
      if (verb === "probe") {
        control.write(`ok ${id}\n`);
        continue;
      }
      if (verb !== "open") continue;
      if (Number(port) !== target) {
        control.write(`fail ${id} ECONNREFUSED\n`);
        continue;
      }
      const stream = connect({ path: socketPath });
      stream.write(`stream ${id}\n`);
      // Server-speaks-first: the greeting rides in the same write as the id
      // line often enough that the host must handle a combined read.
      stream.write("HELLO\n");
      stream.on("data", (d: Buffer) => stream.write(d));
    }
  });
  return control;
}

test("readFirstLine returns the line and unshifts the remainder", async () => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      readFirstLine(socket, 128)
        .then(async (line) => {
          expect(line).toEqual("stream abc");
          const rest = await firstChunk(socket);
          expect(rest.toString()).toEqual("payload");
          socket.destroy();
          server.close();
          resolve();
        })
        .catch(reject);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const client = connect({ port, host: "127.0.0.1" }, () => {
        client.write("stream abc\npayload");
      });
    });
  });
});

test("openStream pairs a stream connection and pipes both directions", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const relay = fakeRelay(socketPath, 3000);
    const stream = await gateway.openStream(3000);
    expect((await firstChunk(stream)).toString()).toEqual("HELLO\n");
    stream.write("ping");
    expect((await firstChunk(stream)).toString()).toEqual("ping");
    stream.destroy();
    relay.destroy();
    await gateway.close();
  });
});

test("openStream rejects when the relay reports a failed dial", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const relay = fakeRelay(socketPath, 3000);
    await expect(gateway.openStream(9999)).rejects.toThrow("ECONNREFUSED");
    relay.destroy();
    await gateway.close();
  });
});

test("openStream rejects when no stream arrives before the pairing timeout", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
      pairingTimeoutMs: 50,
    });
    const silent = connect({ path: socketPath });
    silent.write("control\n");
    await new Promise((r) => setTimeout(r, 20));
    await expect(gateway.openStream(3000)).rejects.toThrow("timed out");
    silent.destroy();
    await gateway.close();
  });
});

test("an aborted openStream retires its id, so the late stream is closed", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    // A relay that accepts the request but never comes back as a stream.
    const control = connect({ path: socketPath });
    control.write("control\n");
    const requested = new Promise<string>((resolve) => {
      control.once("data", (d: Buffer) => resolve(d.toString().trim()));
    });
    const abort = new AbortController();
    const pending = gateway.openStream(3000, abort.signal);
    const id = (await requested).split(" ")[1] as string;
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");

    const late = connect({ path: socketPath });
    late.write(`stream ${id}\n`);
    const closed = await new Promise<boolean>((r) => {
      late.on("close", () => r(true));
      setTimeout(() => r(false), 200);
    });
    expect(closed).toEqual(true);
    control.destroy();
    await gateway.close();
  });
});

test("probe reports why the relay could not be started", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "container-not-running",
    });
    expect(await gateway.probe(3000)).toEqual("container-not-running");
    await gateway.close();
  });
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "unreachable",
    });
    expect(await gateway.probe(3000)).toEqual("relay-unreachable");
    await gateway.close();
  });
});

test("a second control connection is refused while one is live", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const first = fakeRelay(socketPath, 3000);
    await new Promise((r) => setTimeout(r, 20));
    const second = connect({ path: socketPath });
    second.write("control\n");
    const closed = await new Promise<boolean>((r) => {
      second.on("close", () => r(true));
      setTimeout(() => r(false), 200);
    });
    expect(closed).toEqual(true);
    expect(gateway.isRelayConnected()).toEqual(true);
    first.destroy();
    await gateway.close();
  });
});

test("a stream for an unknown id is closed", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const orphan = connect({ path: socketPath });
    orphan.write("stream deadbeefdeadbeef\n");
    const closed = await new Promise<boolean>((r) => {
      orphan.on("close", () => r(true));
      setTimeout(() => r(false), 200);
    });
    expect(closed).toEqual(true);
    await gateway.close();
  });
});

test("close destroys paired streams instead of waiting for them", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const relay = fakeRelay(socketPath, 3000);
    const stream = await gateway.openStream(3000);
    // A live connection must not keep close() from returning.
    await gateway.close();
    expect(stream.destroyed).toEqual(true);
    relay.destroy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/network/port_bind_relay_test.ts`
Expected: FAIL — `Cannot find module './port_bind_relay.ts'`.

- [ ] **Step 3: Write the gateway**

Create `src/network/port_bind_relay.ts`:

```ts
import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import { ensureDir, safeRemove } from "../lib/fs_utils.ts";
import { logDebug } from "../log.ts";
import { MAX_LINE_BYTES, type ProbeResult } from "./port_bind_protocol.ts";

const PAIRING_TIMEOUT_MS = 10_000;
const HALF_OPEN_GRACE_MS = 30_000;

/** What the supervisor reports back when asked to make the relay available. */
export type EnsureRelayResult = "ready" | "container-not-running" | "unreachable";

export class RelayNotReadyError extends Error {
  constructor(readonly reason: Exclude<EnsureRelayResult, "ready">) {
    super(`relay is not available: ${reason}`);
    this.name = "RelayNotReadyError";
  }
}

/**
 * Read one newline-terminated line, then put whatever followed it back on the
 * socket. The relay writes `stream <id>\n` and starts piping immediately, so
 * the line and the first payload bytes routinely arrive in one read.
 *
 * The socket is left **paused** on success: unshifting into a flowing stream
 * would fire `data` with no listener attached and lose the remainder. The
 * caller resumes it, which `pipe()` does on its own.
 */
export function readFirstLine(
  socket: Socket,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > maxBytes) {
          cleanup();
          reject(new Error("line exceeds byte limit"));
        }
        return;
      }
      cleanup();
      const line = buffered.subarray(0, newline).toString("utf8");
      const rest = buffered.subarray(newline + 1);
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      resolve(line);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("connection ended before a line arrived"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

/**
 * Join two sockets. Half-close travels with `end()`; `destroy()` is reserved
 * for errors, for both directions having finished, and for a grace timer that
 * bounds a pair where only one side ever closed. Destroying on a peer's close
 * would discard a write queue that still holds the tail of a response.
 */
export function pipeSockets(
  a: Socket,
  b: Socket,
  opts: { graceMs?: number } = {},
): void {
  const graceMs = opts.graceMs ?? HALF_OPEN_GRACE_MS;
  let finished = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const destroyBoth = () => {
    if (timer) clearTimeout(timer);
    a.destroy();
    b.destroy();
  };
  const onHalfClosed = () => {
    finished += 1;
    if (finished >= 2) {
      destroyBoth();
      return;
    }
    if (!timer) timer = setTimeout(destroyBoth, graceMs);
  };

  a.on("error", destroyBoth);
  b.on("error", destroyBoth);
  a.on("end", onHalfClosed);
  b.on("end", onHalfClosed);
  a.pipe(b);
  b.pipe(a);
}

export interface RelayGateway {
  readonly socketPath: string;
  isRelayConnected(): boolean;
  /**
   * Ask the relay to dial a container port and hand back the paired socket,
   * paused. Aborting retires the id, so a stream that arrives afterwards is
   * refused and the relay drops its end.
   */
  openStream(port: number, signal?: AbortSignal): Promise<Socket>;
  /** Dial and immediately close, to report whether anything is listening. */
  probe(port: number): Promise<ProbeResult>;
  close(): Promise<void>;
}

type Pending =
  | {
      kind: "open";
      resolve: (socket: Socket) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      dispose: () => void;
    }
  | {
      kind: "probe";
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      dispose: () => void;
    };

export async function startRelayGateway(opts: {
  socketPath: string;
  /** Starts the container-side relay if it is not already connected. */
  ensureRelay: () => Promise<EnsureRelayResult>;
  pairingTimeoutMs?: number;
  onRelayLost?: () => void;
  onRelayConnected?: () => void;
}): Promise<RelayGateway> {
  const pairingTimeoutMs = opts.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS;
  const pending = new Map<string, Pending>();
  const streams = new Set<Socket>();
  let control: Socket | null = null;

  await ensureDir(path.dirname(opts.socketPath));
  await safeRemove(opts.socketPath);

  const settle = (id: string, apply: (entry: Pending) => void) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.dispose();
    apply(entry);
  };

  const handleControlLine = (line: string) => {
    const [verb, id, ...rest] = line.split(" ");
    if (verb === "log") {
      logDebug(`[nas] port-relay: ${sanitize(rest.join(" "))}`);
      return;
    }
    if (!id) return;
    if (verb === "ok") {
      settle(id, (entry) => {
        if (entry.kind === "probe") entry.resolve();
        else entry.reject(new Error("relay answered a stream request with ok"));
      });
      return;
    }
    if (verb === "fail") {
      const reason = sanitize(rest.join(" ")) || "dial failed";
      settle(id, (entry) => entry.reject(new Error(reason)));
    }
  };

  const adoptControl = (socket: Socket) => {
    control = socket;
    let buffered = "";
    socket.resume();
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        handleControlLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
      if (buffered.length > MAX_LINE_BYTES) socket.destroy();
    });
    const drop = () => {
      if (control !== socket) return;
      control = null;
      for (const id of [...pending.keys()]) {
        settle(id, (entry) => entry.reject(new Error("relay disconnected")));
      }
      opts.onRelayLost?.();
    };
    socket.on("close", drop);
    socket.on("error", drop);
    opts.onRelayConnected?.();
  };

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    readFirstLine(socket, MAX_LINE_BYTES)
      .then((line) => {
        if (line === "control") {
          if (control) {
            socket.destroy();
            return;
          }
          adoptControl(socket);
          return;
        }
        const [verb, id] = line.split(" ");
        const entry = id ? pending.get(id) : undefined;
        if (verb !== "stream" || !id || !entry || entry.kind !== "open") {
          socket.destroy();
          return;
        }
        streams.add(socket);
        socket.on("close", () => streams.delete(socket));
        settle(id, (e) => {
          if (e.kind === "open") e.resolve(socket);
        });
      })
      .catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", (err) => logDebug(`[nas] port-relay listener: ${err}`));
  // The container process connects as the agent's uid, which is why the socket
  // is world-writable; the directory above it stays 0700.
  await chmod(opts.socketPath, 0o666);

  const request = async (
    kind: "open" | "probe",
    port: number,
    signal?: AbortSignal,
  ): Promise<Socket | void> => {
    const ensured = await opts.ensureRelay();
    if (ensured !== "ready") throw new RelayNotReadyError(ensured);
    const active = control;
    if (!active) throw new RelayNotReadyError("unreachable");
    if (signal?.aborted) throw new Error("request aborted");

    return new Promise<Socket | void>((resolve, reject) => {
      const id = randomBytes(8).toString("hex");
      const onAbort = () => {
        settle(id, (entry) => entry.reject(new Error("request aborted")));
      };
      const timer = setTimeout(() => {
        settle(id, (entry) =>
          entry.reject(new Error(`relay ${kind} timed out`)),
        );
      }, pairingTimeoutMs);
      const dispose = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, {
        kind,
        resolve: resolve as (socket?: Socket) => void,
        reject,
        timer,
        dispose,
      } as Pending);
      active.write(`${kind} ${id} ${port}\n`);
    });
  };

  return {
    socketPath: opts.socketPath,
    isRelayConnected: () => control !== null,
    openStream: async (port, signal) => {
      const socket = await request("open", port, signal);
      if (!socket) throw new Error("relay did not return a stream");
      return socket;
    },
    probe: async (port) => {
      try {
        await request("probe", port);
        return "ok";
      } catch (err) {
        if (err instanceof RelayNotReadyError) {
          return err.reason === "container-not-running"
            ? "container-not-running"
            : "relay-unreachable";
        }
        return "no-answer";
      }
    },
    close: async () => {
      for (const id of [...pending.keys()]) {
        settle(id, (entry) => entry.reject(new Error("gateway closed")));
      }
      // `server.close()` waits for every open connection, so the live ones are
      // destroyed first; otherwise one HMR socket holds the session open.
      for (const stream of streams) stream.destroy();
      streams.clear();
      control?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await safeRemove(opts.socketPath);
    },
  };
}

/** Relay-authored text is attacker-chosen; strip anything a terminal reads. */
function sanitize(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  return text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_LINE_BYTES);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/network/port_bind_relay_test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Format, type check and commit**

```bash
bunx biome check --write src/network/port_bind_relay.ts src/network/port_bind_relay_test.ts
bun run check
git add src/network/port_bind_relay.ts src/network/port_bind_relay_test.ts
git commit -m "feat(port-bind): add the host side of the relay wire protocol"
```

---

### Task 3: Container-side relay script

**Files:**
- Create: `src/docker/embed/port-relay.mjs`
- Test: `src/docker/port_relay_test.ts`
- Modify: `flake.nix:171` (copy the script into the packaged asset dir)

**Interfaces:**
- Consumes: the wire protocol from Task 2, over `NAS_PORT_RELAY_SOCKET`.
- Produces: a script runnable as `bun /usr/local/lib/nas/port-relay.mjs`.

The script is plain JavaScript run by the container's `bun`, so it is tested by
spawning it against a tmpdir socket — no Docker, so this stays in the unit lane.
The test lives one directory above the script because
`resolveAssetDir("docker/embed")` (`src/docker/client.ts:13`) is the Docker build
context, and a test file has no business inside it.

`computeEmbedHash` (`src/docker/client.ts:84`) hashes an explicit list, so adding
a file here does not force an image rebuild — which is correct, since the script
is mounted rather than baked in.

- [ ] **Step 1: Write the failing test**

Create `src/docker/port_relay_test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startRelayGateway } from "../network/port_bind_relay.ts";

const SCRIPT = path.join(import.meta.dir, "embed", "port-relay.mjs");

/** Sockets handed back by the gateway are paused; production resumes via pipe. */
function firstChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk));
    socket.resume();
  });
}

async function withRelay<T>(
  fn: (ctx: {
    gateway: Awaited<ReturnType<typeof startRelayGateway>>;
    echoPort: number;
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-relay-proc-"));
  const socketPath = path.join(dir, "relay.sock");
  const echo = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.write("HELLO\n");
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  await new Promise<void>((resolve) =>
    echo.listen(0, "127.0.0.1", () => resolve()),
  );
  const echoPort = (echo.address() as { port: number }).port;
  const gateway = await startRelayGateway({
    socketPath,
    ensureRelay: async () => "ready",
  });
  const proc = Bun.spawn(["bun", SCRIPT], {
    env: { ...process.env, NAS_PORT_RELAY_SOCKET: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 200 && !gateway.isRelayConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gateway.isRelayConnected()).toEqual(true);
    return await fn({ gateway, echoPort });
  } finally {
    proc.kill();
    await proc.exited;
    await gateway.close();
    echo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the relay pipes a stream to a listening port", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    const stream = await gateway.openStream(echoPort);
    expect((await firstChunk(stream)).toString()).toEqual("HELLO\n");
    stream.write("ping");
    expect((await firstChunk(stream)).toString()).toEqual("ping");
    stream.destroy();
  });
});

test("the relay reports a refused dial instead of opening a stream", async () => {
  await withRelay(async ({ gateway }) => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    await expect(gateway.openStream(closedPort)).rejects.toThrow();
  });
});

test("the relay answers a probe for a listening port", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    expect(await gateway.probe(echoPort)).toEqual("ok");
  });
});

test("a probe for a port nothing listens on comes back as no-answer", async () => {
  await withRelay(async ({ gateway }) => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    expect(await gateway.probe(closedPort)).toEqual("no-answer");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/docker/port_relay_test.ts`
Expected: FAIL — the spawned process exits immediately because the script does not exist.

- [ ] **Step 3: Write the relay script**

Create `src/docker/embed/port-relay.mjs`:

```js
#!/usr/bin/env bun
// port-relay.mjs — Container side of nas port bind.
//
// Connects outward to the host socket bind-mounted at NAS_PORT_RELAY_SOCKET,
// holds one control connection, and on request dials a port on the container's
// own loopback and pipes it back over a fresh connection.

import { connect } from "node:net";

const socketPath = process.env.NAS_PORT_RELAY_SOCKET;
if (!socketPath) {
  console.error("[port-relay] NAS_PORT_RELAY_SOCKET is not set");
  process.exit(1);
}

const control = connect({ path: socketPath });
control.on("error", (err) => {
  console.error(`[port-relay] control: ${err.message}`);
  process.exit(1);
});
control.on("close", () => process.exit(0));
control.on("connect", () => control.write("control\n"));

let buffered = "";
control.on("data", (chunk) => {
  buffered += chunk.toString();
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    handle(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\n");
  }
});

function handle(line) {
  const [verb, id, rawPort] = line.split(" ");
  if (!id) return;
  if (verb !== "probe" && verb !== "open") return;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    control.write(`fail ${id} invalid-port\n`);
    return;
  }
  if (verb === "probe") {
    probe(id, port);
    return;
  }
  open(id, port);
}

function probe(id, port) {
  const target = connect({ port, host: "127.0.0.1" });
  target.on("connect", () => {
    target.destroy();
    control.write(`ok ${id}\n`);
  });
  target.on("error", (err) => control.write(`fail ${id} ${err.code}\n`));
}

// The dial happens before the stream connection so a refusal can be reported
// on the control channel, and so no server bytes arrive with nowhere to go.
function open(id, port) {
  const target = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  function onDialError(err) {
    control.write(`fail ${id} ${err.code}\n`);
    target.destroy();
  }
  target.on("error", onDialError);
  target.on("connect", () => {
    target.pause();
    target.off("error", onDialError);
    // The dev server can reset while the stream connection is being made, and
    // a socket with no error listener takes the process down when it does.
    const holdErrors = () => target.destroy();
    target.on("error", holdErrors);
    const stream = connect({ path: socketPath, allowHalfOpen: true });
    stream.on("error", () => {
      target.destroy();
      stream.destroy();
    });
    stream.on("connect", () => {
      target.off("error", holdErrors);
      stream.write(`stream ${id}\n`);
      pipePair(stream, target);
      target.resume();
    });
  });
}

function pipePair(a, b) {
  let finished = 0;
  let timer = null;
  const destroyBoth = () => {
    if (timer) clearTimeout(timer);
    a.destroy();
    b.destroy();
  };
  const half = () => {
    finished += 1;
    if (finished >= 2) {
      destroyBoth();
      return;
    }
    if (!timer) timer = setTimeout(destroyBoth, 30_000);
  };
  a.on("error", destroyBoth);
  b.on("error", destroyBoth);
  a.on("end", half);
  b.on("end", half);
  a.pipe(b);
  b.pipe(a);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/docker/port_relay_test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Package the script**

`flake.nix:171` copies each embedded asset into the packaged asset directory one
line at a time, and `resolveAsset` (`src/lib/asset.ts:16`) reads from there. Add
`port-relay.mjs` beside `local-proxy.mjs`, or a nix-installed `nas` fails every
bind with a missing script.

- [ ] **Step 6: Format, type check and commit**

```bash
bunx biome check --write src/docker/port_relay_test.ts
bun run check
git add src/docker/embed/port-relay.mjs src/docker/port_relay_test.ts flake.nix
git commit -m "feat(port-bind): add the container-side relay script"
```

---

### Task 4: Detached `docker exec`

**Files:**
- Modify: `src/docker/client.ts:461` (beside `dockerExec`)
- Modify: `src/services/docker.ts:135` (interface), `:263` (Live), `:385` and `:435` (Fake)
- Test: `src/services/docker_test.ts` — this file already exists; append to it

**Interfaces:**
- Produces: `dockerExecDetached(container, cmd, opts)` returning `{ code: number; stderr: string }`, and `DockerService.execDetached` with the same shape.

`dockerExec` waits for the command and discards stderr. The relay is started in
the background and its failure has to be classified — a missing container reads
differently from a missing script — so stderr must survive.

- [ ] **Step 1: Write the failing test**

Append to the existing `src/services/docker_test.ts` (it already covers the
Fake's `inspect` contract; do not replace its contents):

```ts
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { DockerService, makeDockerServiceFake } from "./docker.ts";

test("the fake's execDetached succeeds by default", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const docker = yield* DockerService;
      return yield* docker.execDetached("c", ["bun", "x.mjs"]);
    }).pipe(Effect.provide(makeDockerServiceFake())),
  );
  expect(result).toEqual({ code: 0, stderr: "" });
});

test("execDetached surfaces the override's stderr", async () => {
  const layer = makeDockerServiceFake({
    execDetached: () =>
      Effect.succeed({ code: 1, stderr: "No such container: c" }),
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const docker = yield* DockerService;
      return yield* docker.execDetached("c", ["bun", "x.mjs"]);
    }).pipe(Effect.provide(layer)),
  );
  expect(result.stderr).toContain("No such container");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/services/docker_test.ts`
Expected: FAIL — `execDetached` is not a property of the service.

- [ ] **Step 3: Add the primitive**

In `src/docker/client.ts`, directly after `dockerExec`:

```ts
/**
 * Start a command inside a container and return once Docker has accepted it.
 * Under `-d` the CLI exits immediately, so the exit code reports whether the
 * exec was created, not what the command did; stderr distinguishes a stopped
 * container from a missing executable.
 */
export async function dockerExecDetached(
  containerName: string,
  command: string[],
  options?: { user?: string; env?: Record<string, string> },
): Promise<{ code: number; stderr: string }> {
  const userArgs = options?.user ? ["-u", options.user] : [];
  const envArgs = Object.entries(options?.env ?? {}).flatMap(([k, v]) => [
    "-e",
    `${k}=${v}`,
  ]);
  try {
    await $`docker exec -d ${userArgs} ${envArgs} ${containerName} ${command}`.quiet();
    return { code: 0, stderr: "" };
  } catch (err) {
    const code =
      err && typeof err === "object" && "exitCode" in err
        ? (err as { exitCode: number }).exitCode
        : 1;
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : "";
    return { code, stderr };
  }
}
```

- [ ] **Step 4: Add it to the service**

In `src/services/docker.ts`, in the interface beside `exec`:

```ts
    readonly execDetached: (
      container: string,
      cmd: string[],
      opts?: { user?: string; env?: Record<string, string> },
    ) => Effect.Effect<{ code: number; stderr: string }, Error>;
```

In the Live layer beside `exec`:

```ts
    execDetached: (container, cmd, opts) =>
      Effect.tryPromise({
        try: () => dockerExecDetached(container, cmd, opts),
        catch: wrapError("docker exec -d failed"),
      }),
```

In `DockerServiceFakeConfig`:

```ts
  readonly execDetached?: (
    container: string,
    cmd: string[],
    opts?: { user?: string; env?: Record<string, string> },
  ) => Effect.Effect<{ code: number; stderr: string }, Error>;
```

In the Fake's object literal:

```ts
      execDetached:
        overrides.execDetached ??
        (() => Effect.succeed({ code: 0, stderr: "" })),
```

Add `dockerExecDetached` to the import list `src/services/docker.ts` already
pulls from `../docker/client.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/services/docker_test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Format, type check and commit**

```bash
bunx biome check --write src/docker/client.ts src/services/docker.ts src/services/docker_test.ts
bun run check
git add src/docker/client.ts src/services/docker.ts src/services/docker_test.ts
git commit -m "feat(docker): add a detached exec primitive that keeps stderr"
```

---

### Task 5: Relay supervisor

**Files:**
- Create: `src/network/port_bind_supervisor.ts`
- Test: `src/network/port_bind_supervisor_test.ts`

**Interfaces:**
- Consumes: `EnsureRelayResult` from Task 2.
- Produces: `makeRelaySupervisor(opts)` returning `{ ensure(): Promise<EnsureRelayResult> }`, where the result is `"ready" | "container-not-running" | "unreachable"`.

`docker exec -d` returns as soon as Docker has accepted the exec, so a missing
script or a `bun` that dies on startup still exits zero. Only a stopped
container is distinguishable from stderr; everything else that goes wrong shows
up as a control connection that never arrives. The supervisor therefore reports
just three states, and a session that predates this feature is not one of
them — such a session has no entry in the ports runtime root at all, so the
CLI never reaches a supervisor for it (Task 8 turns that into
`SessionUnreachableError`).

The agent can kill the relay, so "the relay died" must not be counted as a
failure — only an exec that errors, or an exec that produces no control
connection. Giving up is a 60-second cool-off, never permanent, because a
browser connection arriving before the container is up must not poison the
session.

- [ ] **Step 1: Write the failing tests**

Create `src/network/port_bind_supervisor_test.ts`:

```ts
import { expect, test } from "bun:test";
import { makeRelaySupervisor } from "./port_bind_supervisor.ts";

function harness(
  overrides: Partial<Parameters<typeof makeRelaySupervisor>[0]> = {},
) {
  let now = 0;
  const calls: string[][] = [];
  let connected = false;
  const supervisor = makeRelaySupervisor({
    exec: async (cmd) => {
      calls.push(cmd);
      connected = true;
      return { code: 0, stderr: "" };
    },
    command: ["bun", "/usr/local/lib/nas/port-relay.mjs"],
    isRelayConnected: () => connected,
    waitForControl: async () => connected,
    now: () => now,
    sleep: async () => {},
    ...overrides,
  });
  return {
    supervisor,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

test("ensure execs once and reports ready", async () => {
  const h = harness();
  expect(await h.supervisor.ensure()).toEqual("ready");
  expect(h.calls).toHaveLength(1);
});

test("ensure does not exec again while the relay is connected", async () => {
  const h = harness();
  await h.supervisor.ensure();
  await h.supervisor.ensure();
  expect(h.calls).toHaveLength(1);
});

test("a relay that connected and then died is re-exec'd without counting a failure", async () => {
  const h = harness();
  await h.supervisor.ensure();
  h.setConnected(false);
  h.advance(5000);
  expect(await h.supervisor.ensure()).toEqual("ready");
  expect(h.calls).toHaveLength(2);
});

test("a stopped container is reported and never counted as a failure", async () => {
  const h = harness({
    exec: async () => ({ code: 1, stderr: "Error: No such container: nas-agent-x" }),
    waitForControl: async () => false,
  });
  for (let i = 0; i < 5; i += 1) {
    h.advance(3000);
    expect(await h.supervisor.ensure()).toEqual("container-not-running");
  }
  expect(h.calls).toHaveLength(5);
});

test("three failures start a cool-off that a later attempt clears", async () => {
  const h = harness({
    exec: async () => ({ code: 1, stderr: "docker daemon unreachable" }),
    waitForControl: async () => false,
  });
  for (let i = 0; i < 3; i += 1) {
    h.advance(3000);
    expect(await h.supervisor.ensure()).toEqual("unreachable");
  }
  const callsBeforeCoolOff = h.calls.length;
  h.advance(3000);
  expect(await h.supervisor.ensure()).toEqual("unreachable");
  expect(h.calls).toHaveLength(callsBeforeCoolOff);
  h.advance(61_000);
  expect(await h.supervisor.ensure()).toEqual("unreachable");
  expect(h.calls).toHaveLength(callsBeforeCoolOff + 1);
});

test("concurrent callers share one exec", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h = harness({
    exec: async () => {
      await gate;
      return { code: 0, stderr: "" };
    },
  });
  const both = Promise.all([h.supervisor.ensure(), h.supervisor.ensure()]);
  release();
  await both;
  expect(h.calls.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/network/port_bind_supervisor_test.ts`
Expected: FAIL — `Cannot find module './port_bind_supervisor.ts'`.

- [ ] **Step 3: Write the supervisor**

Create `src/network/port_bind_supervisor.ts`:

```ts
const MIN_EXEC_INTERVAL_MS = 2_000;
const COOL_OFF_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const CONTROL_WAIT_MS = 5_000;

import type { EnsureRelayResult } from "./port_bind_relay.ts";

export interface RelaySupervisor {
  ensure(): Promise<EnsureRelayResult>;
}

export interface RelaySupervisorOptions {
  exec: (cmd: string[]) => Promise<{ code: number; stderr: string }>;
  command: string[];
  isRelayConnected: () => boolean;
  waitForControl: (timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Decides whether to start the container-side relay, and how hard to keep
 * trying. A relay that connected and later died is an ordinary event — the
 * agent can kill it — so only a failed exec, or an exec that never produces a
 * control connection, counts against the failure budget.
 */
export function makeRelaySupervisor(
  opts: RelaySupervisorOptions,
): RelaySupervisor {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let inFlight: Promise<EnsureRelayResult> | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let consecutiveFailures = 0;
  let coolOffUntil = Number.NEGATIVE_INFINITY;

  const attempt = async (): Promise<EnsureRelayResult> => {
    if (opts.isRelayConnected()) return "ready";
    if (now() < coolOffUntil) return "unreachable";

    const sinceLast = now() - lastAttemptAt;
    if (sinceLast < MIN_EXEC_INTERVAL_MS) {
      await sleep(MIN_EXEC_INTERVAL_MS - sinceLast);
    }
    lastAttemptAt = now();

    const result = await opts.exec(opts.command);
    if (result.code !== 0) {
      if (isStoppedContainer(result.stderr)) return "container-not-running";
      return noteFailure();
    }
    if (await opts.waitForControl(CONTROL_WAIT_MS)) {
      consecutiveFailures = 0;
      return "ready";
    }
    return noteFailure();
  };

  const noteFailure = (): EnsureRelayResult => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      coolOffUntil = now() + COOL_OFF_MS;
      consecutiveFailures = 0;
    }
    return "unreachable";
  };

  return {
    ensure: () => {
      if (inFlight) return inFlight;
      inFlight = attempt().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/**
 * A stopped container is an expected state, not a fault: retrying changes
 * nothing about it, so it never spends the failure budget.
 */
function isStoppedContainer(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("no such container") || text.includes("is not running");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/network/port_bind_supervisor_test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Format, type check and commit**

```bash
bunx biome check --write src/network/port_bind_supervisor.ts src/network/port_bind_supervisor_test.ts
bun run check
git add src/network/port_bind_supervisor.ts src/network/port_bind_supervisor_test.ts
git commit -m "feat(port-bind): add the relay supervision state machine"
```

---

### Task 6: Port bind broker

**Files:**
- Create: `src/network/port_bind_broker.ts`
- Test: `src/network/port_bind_broker_test.ts`

**Interfaces:**
- Consumes: `RelayGateway` (Task 2), `PortBinding`, `ControlRequest`, `ControlResponse`, `MAX_CONTROL_BYTES` (Task 1), `createUnixServer`, `readJsonLine`, `writeJsonLine` from `src/lib/unix_socket.ts`.
- Produces: `hostPortCandidates(containerPort, requested)`, `startPortBindBroker(opts)` returning `{ bind, unbind, listBindings, close }`.

- [ ] **Step 1: Write the failing tests**

Create `src/network/port_bind_broker_test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { PortBinding } from "./port_bind_protocol.ts";
import { hostPortCandidates, startPortBindBroker } from "./port_bind_broker.ts";

test("hostPortCandidates prefers the container port, then climbs above 1024", () => {
  expect(hostPortCandidates(3000, null).slice(0, 3)).toEqual([3000, 3001, 3002]);
  expect(hostPortCandidates(80, null).slice(0, 3)).toEqual([80, 1024, 1025]);
  expect(hostPortCandidates(3000, null)).toHaveLength(65);
  expect(hostPortCandidates(3000, 9000)).toEqual([9000]);
});

test("hostPortCandidates never proposes a port above 65535", () => {
  const candidates = hostPortCandidates(65_530, null);
  expect(candidates.every((port) => port <= 65_535)).toEqual(true);
});

async function withBroker<T>(
  fn: (ctx: {
    broker: Awaited<ReturnType<typeof startPortBindBroker>>;
    written: PortBinding[][];
    echoPort: number;
    opened: Socket[];
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const echo = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  const echoPort = (echo.address() as { port: number }).port;
  const written: PortBinding[][] = [];
  const opened: Socket[] = [];
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    // The gateway is faked here: this task owns binding bookkeeping, not the
    // wire. Every opened socket is recorded so a test can assert teardown.
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      openStream: async () => {
        const socket = connect({ port: echoPort, host: "127.0.0.1" });
        opened.push(socket);
        return socket;
      },
      probe: async () => "ok",
      close: async () => {},
    },
    persist: async (bindings) => {
      written.push(bindings.map((b) => ({ ...b })));
    },
  });
  try {
    return await fn({ broker, written, echoPort, opened });
  } finally {
    await broker.close();
    echo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** `hostPort: 0` asks the kernel for a free port, which keeps tests off fixed numbers. */
test("bind opens a listener that reaches the container port through the gateway", async () => {
  await withBroker(async ({ broker }) => {
    const result = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const socket = connect({ port: result.hostPort, host: "127.0.0.1" });
    await new Promise<void>((r) => socket.on("connect", () => r()));
    socket.write("ping");
    const echoed = await new Promise<Buffer>((r) =>
      socket.once("data", (d: Buffer) => r(d)),
    );
    expect(echoed.toString()).toEqual("ping");
    socket.destroy();
  });
});

test("bind persists the binding and reports the probe result", async () => {
  await withBroker(async ({ broker, written }) => {
    const result = await broker.bind({ containerPort: 3000, hostPort: 0 });
    expect(result.probe).toEqual("ok");
    expect(written.at(-1)?.[0]?.containerPort).toEqual(3000);
  });
});

test("re-binding the same container port returns the open host port", async () => {
  await withBroker(async ({ broker }) => {
    const first = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const second = await broker.bind({ containerPort: 3000, hostPort: null });
    expect(second.hostPort).toEqual(first.hostPort);
  });
});

test("re-binding with a different explicit host port is a conflict", async () => {
  await withBroker(async ({ broker }) => {
    const first = await broker.bind({ containerPort: 3000, hostPort: 0 });
    await expect(
      broker.bind({ containerPort: 3000, hostPort: first.hostPort + 1 }),
    ).rejects.toThrow("binding-conflict");
  });
});

test("an explicitly requested host port that is taken fails without shifting", async () => {
  await withBroker(async ({ broker, echoPort }) => {
    await expect(
      broker.bind({ containerPort: 3000, hostPort: echoPort }),
    ).rejects.toThrow("host-port-taken");
  });
});

test("unbind closes the listener and its live connections without waiting", async () => {
  await withBroker(async ({ broker, written }) => {
    const bound = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const browser = connect({ port: bound.hostPort, host: "127.0.0.1" });
    await new Promise<void>((r) => browser.on("connect", () => r()));
    // A live connection must not keep unbind from returning.
    await broker.unbind({ containerPort: 3000 });
    expect(written.at(-1)).toEqual([]);
    await expect(
      new Promise<void>((resolve, reject) => {
        const retry = connect({ port: bound.hostPort, host: "127.0.0.1" });
        retry.on("connect", () => {
          retry.destroy();
          resolve();
        });
        retry.on("error", reject);
      }),
    ).rejects.toThrow();
    browser.destroy();
  });
});

test("a browser that disconnects while waiting cancels the stream request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-cancel-"));
  const aborts: boolean[] = [];
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      // Never pairs: resolves only when the request is aborted.
      openStream: (_port, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborts.push(true);
            reject(new Error("request aborted"));
          });
        }),
      probe: async () => "ok",
      close: async () => {},
    },
    persist: async () => {},
  });
  try {
    const bound = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const browser = connect({ port: bound.hostPort, host: "127.0.0.1" });
    await new Promise<void>((r) => browser.on("connect", () => r()));
    browser.destroy();
    for (let i = 0; i < 100 && aborts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(aborts).toEqual([true]);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unbind of an unknown port reports no-such-binding", async () => {
  await withBroker(async ({ broker }) => {
    await expect(broker.unbind({ hostPort: 65_000 })).rejects.toThrow(
      "no-such-binding",
    );
  });
});

test("the control socket answers a bind request", async () => {
  await withBroker(async ({ broker }) => {
    const socket = connect({ path: broker.controlSocketPath });
    await new Promise<void>((r) => socket.on("connect", () => r()));
    socket.write(
      `${JSON.stringify({ type: "bind", containerPort: 3000, hostPort: 0 })}\n`,
    );
    const reply = await new Promise<string>((r) =>
      socket.once("data", (d: Buffer) => r(d.toString())),
    );
    const parsed = JSON.parse(reply) as { ok: boolean; hostPort: number };
    expect(parsed.ok).toEqual(true);
    expect(parsed.hostPort).toBeGreaterThan(0);
    socket.destroy();
  });
});

test("the control socket rejects a port outside 1-65535", async () => {
  await withBroker(async ({ broker }) => {
    const socket = connect({ path: broker.controlSocketPath });
    await new Promise<void>((r) => socket.on("connect", () => r()));
    socket.write(
      `${JSON.stringify({ type: "bind", containerPort: 70_000, hostPort: null })}\n`,
    );
    const reply = await new Promise<string>((r) =>
      socket.once("data", (d: Buffer) => r(d.toString())),
    );
    expect(JSON.parse(reply)).toMatchObject({ ok: false, error: "invalid-request" });
    socket.destroy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/network/port_bind_broker_test.ts`
Expected: FAIL — `Cannot find module './port_bind_broker.ts'`.

- [ ] **Step 3: Write the broker**

Create `src/network/port_bind_broker.ts`:

```ts
import { createServer, type Server, type Socket } from "node:net";
import { safeRemove } from "../lib/fs_utils.ts";
import {
  createUnixServer,
  readJsonLine,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { logDebug } from "../log.ts";
import {
  type ControlErrorKind,
  type ControlRequest,
  MAX_CONTROL_BYTES,
  type PortBinding,
  type ProbeResult,
} from "./port_bind_protocol.ts";
import { pipeSockets, type RelayGateway } from "./port_bind_relay.ts";

const HOST = "127.0.0.1";
const MAX_CANDIDATES = 65;
const MAX_PORT = 65_535;

export class ControlError extends Error {
  constructor(
    readonly kind: ControlErrorKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "ControlError";
  }
}

/**
 * The container port first, then upward from 1024 — a non-root process cannot
 * take the low ports, so climbing from 81 would only produce 943 refusals.
 * An explicit request is the only candidate: substituting it silently would
 * answer a different question than the one asked.
 */
export function hostPortCandidates(
  containerPort: number,
  requested: number | null,
): number[] {
  if (requested !== null) return [requested];
  const candidates = [containerPort];
  let next = Math.max(containerPort + 1, 1024);
  while (candidates.length < MAX_CANDIDATES && next <= MAX_PORT) {
    candidates.push(next);
    next += 1;
  }
  return candidates;
}

export interface PortBindBroker {
  readonly controlSocketPath: string;
  bind(req: {
    containerPort: number;
    /** `null` walks the candidates; `0` asks the kernel for a free port. */
    hostPort: number | null;
  }): Promise<{ hostPort: number; probe: ProbeResult }>;
  unbind(key: { containerPort?: number; hostPort?: number }): Promise<void>;
  listBindings(): PortBinding[];
  close(): Promise<void>;
}

interface OpenBinding {
  binding: PortBinding;
  server: Server;
  /**
   * Live browser connections. `server.close()` waits for every one of them, so
   * an HMR socket would otherwise hold up both unbind and session teardown.
   */
  connections: Set<Socket>;
}

export async function startPortBindBroker(opts: {
  controlSocketPath: string;
  gateway: RelayGateway;
  /** Writes the current set to the registry; the session process is the only writer. */
  persist: (bindings: PortBinding[]) => Promise<void>;
  now?: () => Date;
}): Promise<PortBindBroker> {
  const now = opts.now ?? (() => new Date());
  const open = new Map<number, OpenBinding>();

  const snapshot = (): PortBinding[] =>
    [...open.values()].map((entry) => entry.binding);

  const listenOn = (
    hostPort: number,
    containerPort: number,
    connections: Set<Socket>,
  ): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer({ allowHalfOpen: true }, (browser) => {
        connections.add(browser);
        browser.on("close", () => connections.delete(browser));
        browser.on("error", () => browser.destroy());
        // A browser that gives up while the relay is still dialing must retire
        // the request, or the relay pipes a dev server into a dead socket.
        const abort = new AbortController();
        browser.once("close", () => abort.abort());
        opts.gateway
          .openStream(containerPort, abort.signal)
          .then((stream) => {
            if (browser.destroyed) {
              stream.destroy();
              return;
            }
            pipeSockets(browser, stream);
          })
          .catch((err) => {
            logDebug(`[nas] port-bind: ${containerPort} unreachable: ${err}`);
            browser.destroy();
          });
      });
      server.on("error", reject);
      server.listen(hostPort, HOST, () => {
        server.removeListener("error", reject);
        server.on("error", (err) =>
          logDebug(`[nas] port-bind listener ${hostPort}: ${err}`),
        );
        resolve(server);
      });
    });

  const closeBinding = async (entry: OpenBinding): Promise<void> => {
    for (const socket of entry.connections) socket.destroy();
    entry.connections.clear();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  };

  const bind: PortBindBroker["bind"] = async (req) => {
    const existing = open.get(req.containerPort);
    if (existing) {
      if (
        req.hostPort !== null &&
        req.hostPort !== 0 &&
        req.hostPort !== existing.binding.hostPort
      ) {
        throw new ControlError(
          "binding-conflict",
          `container port ${req.containerPort} is already bound to ${existing.binding.hostPort}`,
        );
      }
      // Probing again keeps the answer honest: the dev server may have started
      // or stopped since the binding was made.
      const probe = await opts.gateway.probe(req.containerPort);
      return { hostPort: existing.binding.hostPort, probe };
    }

    const connections = new Set<Socket>();
    let server: Server | null = null;
    for (const candidate of hostPortCandidates(
      req.containerPort,
      req.hostPort,
    )) {
      try {
        server = await listenOn(candidate, req.containerPort, connections);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
      }
    }
    if (!server) {
      throw new ControlError(
        "host-port-taken",
        req.hostPort !== null
          ? `host port ${req.hostPort} is unavailable`
          : `no free host port near ${req.containerPort}`,
      );
    }
    const address = server.address();
    const chosen =
      address && typeof address === "object" ? address.port : req.containerPort;

    const binding: PortBinding = {
      containerPort: req.containerPort,
      hostPort: chosen,
      createdAt: now().toISOString(),
    };
    open.set(req.containerPort, { binding, server, connections });
    await opts.persist(snapshot());
    const probe = await opts.gateway.probe(req.containerPort);
    return { hostPort: chosen, probe };
  };

  const unbind: PortBindBroker["unbind"] = async (key) => {
    const entry = [...open.values()].find(
      (candidate) =>
        (key.containerPort !== undefined &&
          candidate.binding.containerPort === key.containerPort) ||
        (key.hostPort !== undefined &&
          candidate.binding.hostPort === key.hostPort),
    );
    if (!entry) {
      throw new ControlError("no-such-binding", "no binding matches that key");
    }
    open.delete(entry.binding.containerPort);
    await closeBinding(entry);
    await opts.persist(snapshot());
  };

  await safeRemove(opts.controlSocketPath);
  const control = await createUnixServer(
    opts.controlSocketPath,
    (socket: Socket) => {
      void handleControl(socket);
    },
  );

  function validPort(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PORT;
  }

  async function handleControl(socket: Socket): Promise<void> {
    socket.on("error", () => socket.destroy());
    try {
      const line = await readJsonLine(socket, MAX_CONTROL_BYTES);
      if (!line) return;
      const request = JSON.parse(line) as ControlRequest;
      if (request.type === "bind") {
        if (
          !validPort(request.containerPort) ||
          (request.hostPort !== null &&
            request.hostPort !== 0 &&
            !validPort(request.hostPort))
        ) {
          throw new ControlError("invalid-request", "port must be 1-65535");
        }
        const result = await bind({
          containerPort: request.containerPort,
          hostPort: request.hostPort,
        });
        await writeJsonLine(socket, { ok: true, ...result });
        return;
      }
      const key =
        "containerPort" in request
          ? { containerPort: request.containerPort }
          : { hostPort: request.hostPort };
      const value = Object.values(key)[0];
      if (!validPort(value)) {
        throw new ControlError("invalid-request", "port must be 1-65535");
      }
      await unbind(key);
      await writeJsonLine(socket, { ok: true });
    } catch (err) {
      const kind: ControlErrorKind =
        err instanceof ControlError ? err.kind : "internal";
      await writeJsonLine(socket, {
        ok: false,
        error: kind,
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    } finally {
      socket.end();
    }
  }

  return {
    controlSocketPath: opts.controlSocketPath,
    bind,
    unbind,
    listBindings: snapshot,
    close: async () => {
      for (const entry of open.values()) await closeBinding(entry);
      open.clear();
      await new Promise<void>((r) => control.close(() => r()));
      await safeRemove(opts.controlSocketPath);
      await opts.gateway.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/network/port_bind_broker_test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Format, type check and commit**

```bash
bunx biome check --write src/network/port_bind_broker.ts src/network/port_bind_broker_test.ts
bun run check
git add src/network/port_bind_broker.ts src/network/port_bind_broker_test.ts
git commit -m "feat(port-bind): add the control socket and per-binding listeners"
```

---

### Task 7: Stage, session service and pipeline wiring

**Files:**
- Create: `src/stages/port_bind/stage.ts`, `src/stages/port_bind/port_bind_service.ts`, `src/stages/port_bind.ts`
- Test: `src/stages/port_bind/stage_test.ts`
- Modify: `src/pipeline/types.ts` (add the service to `StageServices`), `src/cli.ts:466` (insert the stage; add the layer to the `Layer.mergeAll`)

**Interfaces:**
- Consumes: `startPortBindBroker` (Task 6), `startRelayGateway` (Task 2), `makeRelaySupervisor` (Task 5), `resolvePortsRuntimePaths` / `relaySocketPath` / `relayScriptPath` / `writeSessionRegistry` (Task 1), `DockerService.execDetached` (Task 4), `mergeContainerPlan` and `MountSpec` from `src/pipeline/`.
- Produces: `planPortBind(input)` returning `{ mounts, relaySocketSource, relayScriptSource }`, `createPortBindStage(shared)`, `PortBindService` Tag / `PortBindServiceLive` / `makePortBindServiceFake`.

Container-side paths, fixed by this task and referenced by every later one:
`/run/nas-ports/relay.sock` and `/usr/local/lib/nas/port-relay.mjs`.

- [ ] **Step 1: Write the failing test**

Create `src/stages/port_bind/stage_test.ts`. Reuse the fixture
helpers in `src/stages/hostexec/stage_test.ts` — `makeHostEnv` (`:91`),
`makeSharedInput` (`:105`) and `makeStageState` (`:137`) — rather than inventing
new ones, then:

```ts
import { expect, test } from "bun:test";
import {
  CONTAINER_RELAY_SCRIPT,
  CONTAINER_RELAY_SOCKET,
  planPortBind,
} from "./stage.ts";

function inputFor(sessionId: string) {
  return { ...makeSharedInput({ sessionId }), ...makeStageState() };
}

test("planPortBind mounts the socket and the script read-only", () => {
  const plan = planPortBind(inputFor("s1"));
  const socketMount = plan.mounts.find(
    (m) => m.target === CONTAINER_RELAY_SOCKET,
  );
  const scriptMount = plan.mounts.find(
    (m) => m.target === CONTAINER_RELAY_SCRIPT,
  );
  expect(socketMount?.readOnly).toEqual(true);
  expect(scriptMount?.readOnly).toEqual(true);
  expect(socketMount?.source).toContain("/brokers/s1/relay.sock");
});

test("planPortBind mounts files, never their parent directory", () => {
  const plan = planPortBind(inputFor("s1"));
  for (const mount of plan.mounts) {
    expect(
      mount.source.endsWith(".sock") || mount.source.endsWith(".mjs"),
    ).toEqual(true);
  }
});

test("planPortBind puts the control socket outside anything mounted", () => {
  const plan = planPortBind(inputFor("s1"));
  for (const mount of plan.mounts) {
    expect(plan.controlSocket.startsWith(`${mount.source}/`)).toEqual(false);
    expect(plan.controlSocket).not.toEqual(mount.source);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/stages/port_bind/stage_test.ts`
Expected: FAIL — `Cannot find module './stage.ts'`.

- [ ] **Step 3: Write the pure planner and the stage**

Create `src/stages/port_bind/stage.ts`. The planner performs no I/O; the stage
body calls only the planner and the service.

```ts
export const CONTAINER_RELAY_SOCKET = "/run/nas-ports/relay.sock";
export const CONTAINER_RELAY_SCRIPT = "/usr/local/lib/nas/port-relay.mjs";

export interface PortBindPlan {
  readonly sessionId: string;
  readonly containerName: string;
  readonly runtimeDir: string;
  readonly relaySocketSource: string;
  readonly relayScriptSource: string;
  readonly controlSocket: string;
  /** `undefined` when the host uid is unknown; the entrypoint then runs as root. */
  readonly relayUser: string | undefined;
  readonly mounts: readonly MountSpec[];
}

export function planPortBind(input: PortBindStageInput): PortBindPlan;
```

Build `runtimeDir` with `portsRuntimeDir(input.host.env.get("XDG_RUNTIME_DIR"), input.host.uid ?? "unknown")`
from Task 1, then derive the three paths with `relaySocketPath`,
`relayScriptPath` and `brokerSocketPath`. Both mounts carry `readOnly: true`.
`relayUser` is `input.host.uid === null ? undefined : String(input.host.uid)`.
Return the container patch through
`mergeContainerPlan(input.container, { mounts: plan.mounts })`, the way
`buildContainerState` does in `src/stages/hostexec/stage.ts:525`.

The stage owns the lifetime, and the service returns a handle — the shape
`src/stages/proxy/stage.ts:426` and `src/stages/hostexec/stage.ts:462` both use:

```ts
export function createPortBindStage(
  shared: StageInput,
): Stage<"container", Pick<StageResult, "container">, PortBindService, unknown> {
  return {
    name: "PortBindStage",
    needs: ["container"],
    run(input) {
      return Effect.gen(function* () {
        const plan = planPortBind({ ...shared, ...input });
        const service = yield* PortBindService;
        yield* Effect.acquireRelease(service.start(plan), (handle) =>
          handle.close(),
        );
        return { container: buildContainerState(input, plan) };
      });
    },
  };
}
```

- [ ] **Step 4: Write the session service**

Create `src/stages/port_bind/port_bind_service.ts` as Tag + Live + Fake, in the
shape of `src/stages/proxy/session_broker_service.ts`. `start(plan)` resolves to
a handle with `close()`, and performs, in order:

1. `resolvePortsRuntimePaths(plan.runtimeDir)`.
2. Copy the embedded script to `relayScriptPath(paths)`. Read it with
   `resolveAsset("docker/embed/port-relay.mjs", import.meta.url, "../../docker/embed/port-relay.mjs")`
   and write it through a temporary file plus a rename, the way
   `src/stages/proxy/network_runtime_service.ts:91` handles the mitmproxy addon.
   A file bind mount pins an inode, so an in-place rewrite would be visible to a
   running container mid-read.
3. `startRelayGateway({ socketPath: plan.relaySocketSource, ensureRelay, onRelayConnected })`.
   `onRelayConnected` resolves whatever `waitForControl` is waiting on; keep a
   single `{ resolve }` slot rather than polling `isRelayConnected()`.
4. `makeRelaySupervisor({ exec, command, isRelayConnected, waitForControl })`
   where `exec` calls
   `docker.execDetached(plan.containerName, ["/usr/local/bin/bun", CONTAINER_RELAY_SCRIPT], { user: plan.relayUser, env: { NAS_PORT_RELAY_SOCKET: CONTAINER_RELAY_SOCKET } })`
   and `waitForControl(timeoutMs)` resolves `true` on `onRelayConnected` or
   `false` on timeout. `ensureRelay` is `supervisor.ensure`.
   The absolute path to `bun` matters: `docker exec` skips the entrypoint, so
   `PATH` is whatever the image sets.
5. `startPortBindBroker` with a `persist` that calls
   `writeSessionRegistry(paths, { sessionId, pid: process.pid, brokerSocket: plan.controlSocket, bindings })`.

`close()` calls `broker.close()` — which closes the gateway — and then
`removeSessionRegistry(paths, plan.sessionId)`.

The gateway's socket is created once and never re-created, for the same reason
the script is renamed rather than rewritten.

The relay spawn goes behind an injected seam, in the manner of
`_relayFactory` in `src/network/forward_port_relay.ts:232`, so the restart paths
stay testable without Docker.

- [ ] **Step 5: Wire it into the pipeline**

In `src/pipeline/types.ts`, add `PortBindService` to the `StageServices` union.
In `src/cli.ts`, import `createPortBindStage` and `PortBindServiceLive`, add the
layer to the existing `Layer.mergeAll`, and insert the stage between
`createDindStage(input)` and `createLaunchStage(input, agentExtraArgs)` at
`src/cli.ts:466`. The socket and the script must exist before `docker run`,
which the launch stage performs in its own `run()`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/stages/port_bind/`
Expected: PASS.

- [ ] **Step 7: Format, type check and commit**

```bash
bunx biome check --write src/stages/port_bind src/stages/port_bind.ts src/pipeline/types.ts src/cli.ts
bun run check
git add src/stages/port_bind src/stages/port_bind.ts src/pipeline/types.ts src/cli.ts
git commit -m "feat(port-bind): own the relay socket for the session's lifetime"
```

---

### Task 8: Domain service for CLI and UI

**Files:**
- Create: `src/domain/port_bind/types.ts`, `src/domain/port_bind/service.ts`, `src/domain/port_bind.ts`
- Test: `src/domain/port_bind/service_test.ts`

**Interfaces:**
- Consumes: `resolvePortsRuntimePaths`, `listPortBindSessions`, `findSessionsByHostPort`, `brokerSocketPath` (Task 1); `gcRuntime` from `src/lib/runtime_registry.ts`; `connectUnix`, `readJsonLine`, `writeJsonLine` from `src/lib/unix_socket.ts`.
- Produces: `PortBindService` Tag with `list(paths)`, `bind(paths, sessionId, containerPort, hostPort)`, `unbindByKey(paths, key)`; `PortBindServiceLive`; `makePortBindServiceFake(overrides)`; `makePortBindClient(layer?)`; error classes `HostPortTakenError`, `BindingConflictError`, `NoSuchBindingError`, `InvalidRequestError`, `InternalBrokerError`, `SessionUnreachableError`, `AmbiguousHostPortError`.

Read `src/domain/network/service.ts` end to end first; this service is the same
shape with a wider surface.

- [ ] **Step 1: Write the failing tests**

Create `src/domain/port_bind/service_test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { resolvePortsRuntimePaths } from "../../network/port_bind_registry.ts";
import { makePortBindServiceFake, PortBindService } from "./service.ts";
import { AmbiguousHostPortError, NoSuchBindingError } from "./types.ts";

async function withPaths<T>(
  fn: (paths: Awaited<ReturnType<typeof resolvePortsRuntimePaths>>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "nas-ports-domain-"));
  try {
    return await fn(await resolvePortsRuntimePaths(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the fake lists nothing by default", async () => {
  await withPaths(async (paths) => {
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.list(paths);
      }).pipe(Effect.provide(makePortBindServiceFake())),
    );
    expect(listed).toEqual([]);
  });
});

test("unbinding a host port no session claims fails with NoSuchBindingError", async () => {
  await withPaths(async (paths) => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.unbindByKey(paths, { hostPort: 9999 });
      }).pipe(
        Effect.provide(
          makePortBindServiceFake({
            unbindByKey: () => Effect.fail(new NoSuchBindingError("none")),
          }),
        ),
      ),
    );
    expect(result._tag).toEqual("Failure");
  });
});

test("two live sessions claiming one host port is reported, not guessed", () => {
  const err = new AmbiguousHostPortError(8080, ["s1", "s2"]);
  expect(err.message).toContain("8080");
  expect(err.message).toContain("s1");
});
```

Add two live tests against the real `PortBindServiceLive`, using the same
tmpdir helper: one that writes two registry entries, starts a stub control
socket answering `{"ok":true}`, and asserts `unbindByKey({hostPort})` reaches
the session that claims that port; and one that calls `bind` for a session id
with no registry entry and expects `SessionUnreachableError`. The second is how
a session started before this feature existed surfaces — it has no entry in the
ports runtime root at all — so the CLI message about restarting the session
hangs off that error, not off a probe result.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/domain/port_bind/service_test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the error types**

Create `src/domain/port_bind/types.ts`. Every class extends `Error` — the
repository maps typed errors by `instanceof`, never with `Data.TaggedError`:

```ts
export class HostPortTakenError extends Error {}
export class BindingConflictError extends Error {}
export class NoSuchBindingError extends Error {}
export class InvalidRequestError extends Error {}
export class InternalBrokerError extends Error {}
export class SessionUnreachableError extends Error {}

export class AmbiguousHostPortError extends Error {
  constructor(hostPort: number, sessionIds: string[]) {
    super(
      `host port ${hostPort} is claimed by ${sessionIds.join(", ")}; run nas network gc`,
    );
    this.name = "AmbiguousHostPortError";
  }
}
```

Give each of the first six a constructor that sets `this.name`, matching
`src/domain/container/lifecycle_service.ts`. `SessionUnreachableError` is raised
by the client itself — a session with no registry entry, or a control socket
that refuses — and is what a session started before this feature produces.

- [ ] **Step 4: Write the service**

Create `src/domain/port_bind/service.ts` with Tag `"nas/PortBindService"`, an
honest `R` on Live, a Fake whose defaults are empty and successful, and
`makePortBindClient(layer = PortBindServiceLive)` closing `R`.

- `list(paths)` runs `gcRuntime` first, then `listPortBindSessions`. Sweeping
  before reading is what keeps a session killed with SIGKILL from claiming a
  port a live session has since taken; `getSessions` in `src/ui/data.ts:301`
  does the same.
- `bind(paths, sessionId, containerPort, hostPort)` connects to
  `brokerSocketPath(paths, sessionId)`, writes one JSON line, reads one back,
  and converts `{ok:false,error}` into the matching error class. A refused
  connection becomes `SessionUnreachableError` naming `nas network gc`.
- `unbindByKey(paths, key)` resolves a `hostPort` key through
  `findSessionsByHostPort` after the GC, fails with `AmbiguousHostPortError` on
  more than one live claimant, then sends the request to that session.

Create the barrel `src/domain/port_bind.ts` re-exporting the Tag, Live, Fake,
client and types, following `src/domain/network.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/domain/port_bind/`
Expected: PASS.

- [ ] **Step 6: Format, type check and commit**

```bash
bunx biome check --write src/domain/port_bind src/domain/port_bind.ts
bun run check
git add src/domain/port_bind src/domain/port_bind.ts
git commit -m "feat(port-bind): add the domain service shared by CLI and UI"
```

---

### Task 9: CLI subcommands

**Files:**
- Create: `src/cli/port_bind_args.ts`
- Test: `src/cli/port_bind_args_test.ts`
- Modify: `src/cli/network.ts:22` (dispatch), `src/fzf_review.ts` (single-select picker), `src/cli/usage.ts` (help text)

**Interfaces:**
- Consumes: `makePortBindClient` (Task 8), `hasFormatJson` from `src/cli/helpers.ts`.
- Produces: `parseBindArgs(args)` returning `{ sessionId, containerPort, hostPort }`, `parseUnbindArgs(args)` returning `{ sessionId, containerPort } | { hostPort } | null`.

`positionalArgsAfterSubcommand` (`src/cli/helpers.ts:28`) takes exactly two
positionals and strips only `--scope` and `--runtime-dir`, so these subcommands
need their own parser.

- [ ] **Step 1: Write the failing test**

Create `src/cli/port_bind_args_test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseBindArgs, parseUnbindArgs } from "./port_bind_args.ts";

test("bind parses session, container port and optional host port", () => {
  expect(parseBindArgs(["abc123:3000"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
    hostPort: null,
  });
  expect(parseBindArgs(["abc123:3000", "9000"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
    hostPort: 9000,
  });
});

test("bind ignores flags and their values among the positionals", () => {
  expect(
    parseBindArgs(["--runtime-dir", "/tmp/x", "abc123:3000", "--format", "json"]),
  ).toEqual({ sessionId: "abc123", containerPort: 3000, hostPort: null });
});

test("bind rejects a malformed key or an out-of-range port", () => {
  expect(() => parseBindArgs(["abc123"])).toThrow("session-id:container-port");
  expect(() => parseBindArgs(["abc123:0"])).toThrow("1-65535");
  expect(() => parseBindArgs(["abc123:70000"])).toThrow("1-65535");
});

test("unbind accepts either key, or nothing", () => {
  expect(parseUnbindArgs(["abc123:3000"])).toEqual({
    sessionId: "abc123",
    containerPort: 3000,
  });
  expect(parseUnbindArgs(["9000"])).toEqual({ hostPort: 9000 });
  expect(parseUnbindArgs([])).toEqual(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli/port_bind_args_test.ts`
Expected: FAIL — `Cannot find module './port_bind_args.ts'`.

- [ ] **Step 3: Write the parser**

Create `src/cli/port_bind_args.ts`. Split the key on the last colon so a session
id containing one still parses. Validate ports as integers in 1–65535. Throw
`Error` with a message naming the expected shape; the CLI prints it.

- [ ] **Step 4: Wire the subcommands**

In `src/cli/network.ts`, branch on `bind` and `unbind` before the call to
`handleApprovalSubcommand`, since `sub === undefined` there means the pending
list. `--runtime-dir` on these two names the ports root and defaults to
`defaultRuntimeDir("ports")`; say so in `src/cli/usage.ts`, because the same
flag means the network root for `approve` and `deny`.

- `nas network bind` with no positionals prints the list: session id, container
  port, host port, age; `--format json` emits the same fields as an array.
- `nas network bind <key> [host-port]` prints `http://localhost:<port> で開きました`
  followed by the probe result: nothing extra for `ok`, a line saying the port
  did not answer for `no-answer`, a line saying the container is not running for
  `container-not-running`, and a line saying the relay could not be started for
  `relay-unreachable`. A `SessionUnreachableError` — no registry entry, or a
  control socket that refuses — prints instead that the session cannot be
  reached, that it may predate this feature, and that restarting it or running
  `nas network gc` is the fix.
- `nas network unbind` with no positionals opens the picker from Step 5.

Construct the client with `const client = makePortBindClient()` inside
`runNetworkCommand()`, matching the sibling subcommands.

- [ ] **Step 5: Add the single-select picker**

In `src/fzf_review.ts`, add `runFzfSelect(items, opts)` beside `runFzfReview`,
sharing the spawn and the missing-fzf fallback. `runFzfReview` keeps its
`--expect=enter,ctrl-d` and scope prompt; the new function returns the chosen
item or `null`. When fzf is absent, print the list and tell the user to pass an
argument.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/cli/`
Expected: PASS.

- [ ] **Step 7: Format, type check and commit**

```bash
bunx biome check --write src/cli/port_bind_args.ts src/cli/port_bind_args_test.ts src/cli/network.ts src/cli/usage.ts src/fzf_review.ts
bun run check
git add src/cli/port_bind_args.ts src/cli/port_bind_args_test.ts src/cli/network.ts src/cli/usage.ts src/fzf_review.ts
git commit -m "feat(port-bind): add nas network bind and unbind"
```

---

### Task 10: UI endpoints

**Files:**
- Modify: `src/ui/data.ts:149` (context), `:288` (sessions data), `src/ui/routes/api.ts:194` (routes), `src/ui/routes/with_error_handling.ts` (status mapping), `src/ui/routes/sse.ts:66` and `src/ui/routes/sse_diff.ts` (snapshot)
- Test: `src/ui/routes/api_integration_test.ts`, `src/ui/routes/sse_diff_test.ts`

**Interfaces:**
- Consumes: `makePortBindClient` and the error classes (Task 8), `isSafeId` from `src/ui/routes/validate_ids.ts`.
- Produces: `POST /api/network/bind`, `POST /api/network/unbind`, and a `portBindings` field on the sessions snapshot.

- [ ] **Step 1: Write the failing tests**

In `src/ui/routes/api_integration_test.ts`, beside the existing
`POST /network/approve` tests:

```ts
test("POST /network/bind returns 400 without required fields", async () => {
  const res = await app.request("/api/network/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "s1" }),
  });
  expect(res.status).toEqual(400);
});

test("POST /network/bind rejects an unsafe session id", async () => {
  const res = await app.request("/api/network/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "../etc", containerPort: 3000 }),
  });
  expect(res.status).toEqual(400);
});

test("POST /network/bind rejects a port outside 1-65535", async () => {
  const res = await app.request("/api/network/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", containerPort: 70000 }),
  });
  expect(res.status).toEqual(400);
});

test("a taken host port surfaces as 409", async () => {
  // Provide a data context whose client fails with HostPortTakenError.
  expect(mapErrorToResponse(new HostPortTakenError("taken")).status).toEqual(409);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/ui/routes/api_integration_test.ts`
Expected: FAIL — the route returns 404.

- [ ] **Step 3: Add the wrappers and the routes**

In `src/ui/data.ts`: add `portsPaths` to `UiDataContext` and `createDataContext`,
a module-level `const portBindClient = makePortBindClient()`, and
`bindPort(ctx, sessionId, containerPort, hostPort)`,
`unbindPort(ctx, key)`, `getPortBindings(ctx)` wrappers — the same three-line
shape as `approveNetwork`.

In `src/ui/routes/api.ts`: two `api.post` handlers that validate with `isSafeId`
and a port range check before calling, following the existing
`/network/approve` handler.

In `src/ui/routes/with_error_handling.ts`: map `HostPortTakenError`,
`BindingConflictError` and `AmbiguousHostPortError` to 409, `NoSuchBindingError`
to 404, `SessionUnreachableError` to 503, and the broker's `internal` kind to
500.

- [ ] **Step 4: Add the snapshot field**

In `src/ui/routes/sse.ts`, poll `getPortBindings` alongside the five existing
snapshots; in `sse_diff.ts`, diff it by session id and host port, emitting the
event name `port-bindings` — Task 11's dispatch keys off that exact string. Add
a `sse_diff_test.ts` case asserting that adding and removing a binding each
produce one event.

These route tests live in `api_integration_test.ts`, which the unit lane skips
by name. That is deliberate: the file already builds a real app instance, and
splitting the new cases out would duplicate that scaffolding.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/ui/`
Expected: PASS.

- [ ] **Step 6: Format, type check and commit**

```bash
bunx biome check --write src/ui/data.ts src/ui/routes
bun run check
git add src/ui/data.ts src/ui/routes
git commit -m "feat(port-bind): expose bind and unbind from nas UI"
```

---

### Task 11: UI panel

**Files:**
- Modify: `src/ui/frontend/src/stores/types.ts`, `src/ui/frontend/src/hooks/createSseDispatch.ts`, `src/ui/frontend/src/api/client.ts`
- Create: `src/ui/frontend/src/components/ports/PortBindingsPanel.tsx`

**Interfaces:**
- Consumes: the `portBindings` snapshot field and the two endpoints from Task 10.

- [ ] **Step 1: Extend the store types**

Add the binding type to `stores/types.ts` and carry the new snapshot field
through `createSseDispatch.ts`, keyed on the `port-bindings` event name that
Task 10 emits, following how pending approvals travel.

- [ ] **Step 2: Add the API calls**

In `src/ui/frontend/src/api/client.ts`, add `bindPort` and `unbindPort` beside
the existing approval calls.

- [ ] **Step 3: Build the panel**

`PortBindingsPanel.tsx` lists the current session's bindings with the host port
as a link to `http://localhost:<port>`, an unbind control per row, and a small
form taking a container port. Match the surrounding Solid components; read
`.claude/skills` for any frontend conventions before writing it.

- [ ] **Step 4: Build and check**

Run: `bun run build-ui && bun run check`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write src/ui/frontend/src
git add src/ui/frontend/src
git commit -m "feat(port-bind): show and edit bindings in nas UI"
```

---

### Task 12: End-to-end integration test and documentation

**Files:**
- Create: `src/stages/port_bind/integration_test.ts`
- Modify: `README.md` (the table of what each setting widens)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the integration test**

Create `src/stages/port_bind/integration_test.ts`. The filename suffix is what
keeps it out of the unit lane. Guard every test with
`test.skipIf(!dockerAvailable)`, copying the availability probe and the
`finally` cleanup from `src/docker/client_integration_test.ts`.

The test: start a container from `nas-sandbox:latest` with the relay socket and
script bind-mounted read-only exactly as `planPortBind` describes; start a
server inside it that listens on `127.0.0.1:3000`; start the gateway and broker
on the host; bind; connect to the host port; assert the response came from the
container. Then assert the two properties the design rests on — that the
container cannot unlink the mounted socket, and that a non-root process inside
it can still connect.

- [ ] **Step 2: Run it**

Run: `bun test src/stages/port_bind/integration_test.ts`
Expected: PASS, or skipped when Docker is unavailable.

- [ ] **Step 3: Document the boundary**

In `README.md`, add a row to the table of what each setting widens: a binding
puts an agent-authored page on the user's loopback, from where it can reach
other services on `127.0.0.1`.

- [ ] **Step 4: Run the full suite once**

Run: `bun run test`
Expected: PASS. This is the single full run; do not repeat it per file.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write src/stages/port_bind README.md
git add src/stages/port_bind/integration_test.ts README.md
git commit -m "test(port-bind): cover the container path end to end"
```
