#!/usr/bin/env bun
// port-relay.mjs — Container side of nas port bind.
//
// Connects outward to the host socket bind-mounted at NAS_PORT_RELAY_SOCKET,
// holds one control connection, and on request dials a port on the container's
// own loopback and pipes it back over a fresh connection.

import { connect } from "node:net";

const MAX_LINE_BYTES = 128;
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
