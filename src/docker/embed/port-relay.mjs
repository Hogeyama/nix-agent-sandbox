#!/usr/bin/env bun
// port-relay.mjs — Container side of nas port bind and port forward.
//
// Connects outward to the host socket bind-mounted at NAS_PORT_RELAY_SOCKET,
// holds one control connection, and on request either dials a port on the
// container's own loopback and pipes it back over a fresh connection (bind),
// or listens on the container's loopback and hands each accepted client to the
// host over a fresh connection (forward).

import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";

const MAX_LINE_BYTES = 128;
// Overridable so tests can point the scan at fixture files; the host only ever
// sets NAS_PORT_RELAY_SOCKET, and nothing inside the container can change the
// environment of an already-running relay.
const PROC_DIR = process.env.NAS_PORT_RELAY_PROC_DIR ?? "/proc";
const WATCH_INTERVAL_MS = Number(process.env.NAS_PORT_RELAY_WATCH_MS) || 1000;
const LISTEN_STATE = "0A";
/** Higher wins when the same port is bound on several addresses. */
const SCOPE_RANK = { any: 3, loopback: 2, loopback6: 1, remote: 0 };
/** Used when the kernel's range is unreadable; the usual Linux default. */
const DEFAULT_EPHEMERAL_RANGE = [32768, 60999];
const socketPath = process.env.NAS_PORT_RELAY_SOCKET;
if (!socketPath) {
  console.error("[port-relay] NAS_PORT_RELAY_SOCKET is not set");
  process.exit(1);
}

const waitInitial = process.argv.includes("--wait-initial");
let initialReady = false;

const control = connect({ path: socketPath });
control.on("error", (err) => {
  console.error(`[port-relay] control: ${err.message}`);
  process.exit(1);
});
control.on("close", () => process.exit(waitInitial && !initialReady ? 1 : 0));
control.on("connect", () => control.write("control-v2\n"));

let buffered = "";
control.on("data", (chunk) => {
  buffered += chunk.toString();
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (
      Buffer.byteLength(line) > MAX_LINE_BYTES ||
      !/^[\x20-\x7e]*$/.test(line)
    ) {
      control.destroy();
      return;
    }
    if (!handle(line)) {
      control.destroy();
      return;
    }
    newline = buffered.indexOf("\n");
  }
  if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) control.destroy();
});

function handle(line) {
  if (line === "initial-ready") {
    if (waitInitial && !initialReady) process.stdout.write("ready\n");
    initialReady = true;
    return true;
  }
  const initialFailure = /^initial-failed (.+)$/.exec(line);
  if (initialFailure) {
    process.stderr.write(`initial-failed ${initialFailure[1]}\n`);
    process.exit(1);
  }
  const removal = /^unforward ([0-9a-f]{16}) ([0-9a-f]{32})$/.exec(line);
  if (removal) {
    unforward(removal[1], removal[2]);
    return true;
  }
  const addition = /^forward ([0-9a-f]{16}) ([0-9a-f]{32}) ([0-9]{1,5})$/.exec(
    line,
  );
  if (addition) {
    const port = Number(addition[3]);
    if (port < 1 || port > 65535)
      control.write(`fail ${addition[1]} invalid-port\n`);
    else forward(addition[1], addition[2], port);
    return true;
  }
  const watch = /^watch (0|1)$/.exec(line);
  if (watch) {
    setWatching(watch[1] === "1");
    return true;
  }
  const request = /^(probe|open) ([0-9a-f]{16}) ([0-9]+)$/.exec(line);
  if (!request) return false;
  const [, verb, id, rawPort] = request;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    control.write(`fail ${id} invalid-port\n`);
    return true;
  }
  if (verb === "probe") {
    probe(id, port);
    return true;
  }
  open(id, port);
  return true;
}

// --- Forwards: container listener, host dials the real service ---
//
// The host is the record of which ports are forwarded; this map is only what
// is currently listening. A restarted relay starts empty and the host re-sends
// every forward it still wants.

/** containerPort -> listener resources, including its current mapping token. */
const forwards = new Map();

function forward(id, token, port) {
  if (forwards.has(port)) {
    control.write(`fail ${id} EADDRINUSE\n`);
    return;
  }
  const connections = new Set();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    connections.add(client);
    client.once("close", () => connections.delete(client));
    // Most protocols speak client-first, so bytes arrive before the host has
    // anywhere to put them. They are held here and written ahead of the pipe;
    // pausing an accepted socket is not reliable under Bun.
    const held = [];
    const hold = (chunk) => held.push(chunk);
    client.on("data", hold);
    const stream = connect({ path: socketPath, allowHalfOpen: true });
    connections.add(stream);
    stream.once("close", () => connections.delete(stream));
    const abandon = () => {
      client.destroy();
      stream.destroy();
    };
    client.once("error", abandon);
    stream.once("error", abandon);
    stream.once("connect", () => {
      if (client.destroyed) {
        stream.destroy();
        return;
      }
      client.off("error", abandon);
      stream.off("error", abandon);
      client.off("data", hold);
      stream.write(`client ${token}\n`);
      for (const chunk of held) stream.write(chunk);
      pipePair(stream, client);
    });
  });
  const entry = {
    token,
    server,
    connections,
    ready: false,
    cancelled: false,
    removals: [],
  };
  forwards.set(port, entry);
  const acknowledgeRemoval = () => {
    for (const requestId of entry.removals) control.write(`ok ${requestId}\n`);
    entry.removals = [];
  };
  entry.close = () => server.close(acknowledgeRemoval);
  const onListenError = (err) => {
    if (forwards.get(port) === entry) forwards.delete(port);
    control.write(`fail ${id} ${err.code ?? "listen-failed"}\n`);
    acknowledgeRemoval();
  };
  server.once("error", onListenError);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", onListenError);
    entry.ready = true;
    if (entry.cancelled) {
      entry.close();
      return;
    }
    server.on("error", (err) =>
      control.write(`log forward ${port}: ${err.code ?? err.message}\n`),
    );
    control.write(`ok ${id}\n`);
  });
}

function unforward(id, token) {
  const found = [...forwards.entries()].find(
    ([, entry]) => entry.token === token,
  );
  if (!found) {
    control.write(`ok ${id}\n`);
    return;
  }
  const [port, entry] = found;
  forwards.delete(port);
  entry.cancelled = true;
  entry.removals.push(id);
  for (const connection of entry.connections) connection.destroy();
  entry.connections.clear();
  if (entry.ready) entry.close();
}

// --- Listener detection ---
//
// The relay shares the container's network namespace, so /proc/net/tcp{,6}
// already lists every server started inside it. Scanning costs a couple of
// KB per second and needs no privileges, but it only runs while the host has
// asked for it: nothing polls for a suggestion nobody is waiting for.

let watchTimer = null;
/** Ports seen by the previous scan, so a one-shot server is not reported. */
let previousScan = null;
/** Ports the host has been told about, and the scope it was told. */
let reported = new Map();
/** The kernel's ephemeral range, read once per watch. */
let ephemeral = DEFAULT_EPHEMERAL_RANGE;

function setWatching(enabled) {
  if (!enabled) {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    previousScan = null;
    reported = new Map();
    return;
  }
  if (watchTimer) return;
  previousScan = null;
  watchTimer = setInterval(() => {
    void scanOnce();
  }, WATCH_INTERVAL_MS);
  // The first scan waits for the range so no report can precede it.
  void readEphemeralRange().then((range) => {
    ephemeral = range;
    void scanOnce();
  });
}

/**
 * Ports the kernel hands out on its own. A server there was not asked for by
 * a person — it is a Testcontainers publish, a debugger, a random client
 * socket that happens to listen — so suggesting it would bury the one port
 * the user actually started.
 */
async function readEphemeralRange() {
  let text;
  try {
    text = await readFile(
      `${PROC_DIR}/sys/net/ipv4/ip_local_port_range`,
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

async function scanOnce() {
  if (control.destroyed) return;
  const current = new Map();
  await collect(`${PROC_DIR}/net/tcp`, ipv4Scope, current);
  await collect(`${PROC_DIR}/net/tcp6`, ipv6Scope, current);
  if (control.destroyed || watchTimer === null) return;

  // A port has to survive two consecutive scans before it counts: a test's
  // throwaway server should not turn into a suggestion. Disappearing needs no
  // such confirmation, so a closed port stops being suggested right away.
  const confirmed = new Map();
  if (previousScan !== null) {
    for (const [port, scope] of current) {
      if (previousScan.has(port)) confirmed.set(port, scope);
    }
  }
  previousScan = current;
  publish(confirmed);
}

function publish(confirmed) {
  for (const [port, scope] of confirmed) {
    if (reported.get(port) === scope) continue;
    reported.set(port, scope);
    control.write(`listen ${port} ${scope}\n`);
  }
  for (const port of [...reported.keys()]) {
    if (confirmed.has(port)) continue;
    reported.delete(port);
    control.write(`unlisten ${port}\n`);
  }
}

async function collect(file, scopeOf, into) {
  let text;
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
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
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
function ipv4Scope(hex) {
  if (!/^[0-9A-F]{8}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  if (value === 0) return "any";
  return (value & 0xff) === 127 ? "loopback" : "remote";
}

function ipv6Scope(hex) {
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

function probe(id, port) {
  const target = connect({ port, host: "127.0.0.1" });
  target.on("connect", () => {
    target.destroy();
    control.write(`ok ${id}\n`);
  });
  target.on("error", (err) =>
    control.write(`fail ${id} ${err.code ?? "dial-failed"}\n`),
  );
}

// The dial happens before the stream connection so a refusal can be reported
// on the control channel, and so no server bytes arrive with nowhere to go.
function open(id, port) {
  const target = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  function onDialError(err) {
    control.write(`fail ${id} ${err.code ?? "dial-failed"}\n`);
    target.destroy();
  }
  target.on("error", onDialError);
  target.on("connect", () => {
    target.pause();
    target.off("error", onDialError);
    // The dev server can reset while the stream connection is being made, and
    // a socket with no error listener takes the process down when it does.
    let targetFailed = false;
    const holdErrors = (err) => {
      targetFailed = true;
      control.write(`fail ${id} ${err.code ?? "dial-failed"}\n`);
      target.destroy();
    };
    target.on("error", holdErrors);
    const stream = connect({ path: socketPath, allowHalfOpen: true });
    stream.on("error", () => {
      target.destroy();
      stream.destroy();
    });
    stream.on("connect", () => {
      if (targetFailed || target.destroyed) {
        stream.destroy();
        return;
      }
      target.off("error", holdErrors);
      stream.write(`stream ${id}\n`);
      pipePair(stream, target);
      target.resume();
    });
  });
}

function pipePair(a, b) {
  let closed = false;
  let timer = null;
  const ended = new Set();
  const destroyBoth = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    a.destroy();
    b.destroy();
  };
  const half = (socket) => {
    ended.add(socket);
    if (ended.size >= 2) {
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!timer) timer = setTimeout(destroyBoth, 30_000);
  };
  a.on("error", destroyBoth);
  b.on("error", destroyBoth);
  a.on("end", () => half(a));
  b.on("end", () => half(b));
  a.on("close", () => {
    if (!ended.has(a)) destroyBoth();
  });
  b.on("close", () => {
    if (!ended.has(b)) destroyBoth();
  });
  a.pipe(b);
  b.pipe(a);
}
