// Behavioural check that srt's proxy carries strait's patches.
//
// Unpatched srt tunnels SOCKS and non-TLS CONNECT streams without TLS
// termination, so filterRequest never sees them. A dependency bump or a
// patch that failed to apply would reopen that silently, so strait probes the
// live proxy before starting the command. Against a patched proxy neither
// probe dials upstream; an unpatched one relays the second to github.com.

import { connect, type Socket } from "node:net";

const TIMEOUT_MS = 3000;

export async function assertProxyPatched(
  port: number,
  proxyAuthToken: string | undefined,
): Promise<void> {
  // SOCKS5 greeting: VER=5, one method, no-auth.
  const socks = await probe(port, [Buffer.from([0x05, 0x01, 0x00])]);
  if (socks.received.length > 0) {
    throw new Error("srt proxy answered SOCKS; the SOCKS patch is missing");
  }
  if (!socks.closed) {
    throw new Error("srt proxy kept a SOCKS connection open");
  }

  const auth =
    proxyAuthToken === undefined
      ? ""
      : `Proxy-Authorization: Basic ${Buffer.from(`srt:${proxyAuthToken}`).toString("base64")}\r\n`;
  const connectReq = Buffer.from(
    `CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n${auth}\r\n`,
  );
  // A TLS server on the far side closes on the SSH banner just as the patched
  // proxy does, so the socket alone cannot tell the two apart. srt's own debug
  // log records which branch it took; capture it for the duration of the probe.
  const log = await captureSrtLog(() =>
    probe(port, [connectReq, Buffer.from("SSH-2.0-strait-selfcheck\r\n")]),
  );
  const reply = log.result.received.toString("latin1");
  if (!reply.startsWith("HTTP/1.1 200")) {
    throw new Error(
      `selfcheck CONNECT was not accepted: ${JSON.stringify(reply.slice(0, 40))}`,
    );
  }
  const refused = log.lines.some((l) =>
    l.includes("non-TLS bytes on CONNECT github.com:443; refused"),
  );
  if (!refused || log.lines.some((l) => l.includes("opaque-tunnelling"))) {
    throw new Error(
      "srt proxy relayed a non-TLS stream; the non-TLS CONNECT patch is missing",
    );
  }
}

async function captureSrtLog<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const prevDebug = process.env.SRT_DEBUG;
  const prevError = console.error;
  process.env.SRT_DEBUG = "1";
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[SandboxDebug]")) lines.push(line);
    else prevError(...args);
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = prevError;
    if (prevDebug === undefined) delete process.env.SRT_DEBUG;
    else process.env.SRT_DEBUG = prevDebug;
  }
}

async function probe(
  port: number,
  writes: Buffer[],
): Promise<{ received: Buffer; closed: boolean }> {
  const sock: Socket = connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  sock.on("data", (c) => chunks.push(c));
  const closed = new Promise<boolean>((resolve) => {
    sock.once("close", () => resolve(true));
    sock.once("error", () => resolve(true));
    setTimeout(() => resolve(false), TIMEOUT_MS).unref();
  });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.write(writes[0]);
  if (writes.length > 1) {
    // CONNECT answers 200 before reading the client's first bytes.
    await waitFor(() => Buffer.concat(chunks).includes("\r\n\r\n"));
    for (const w of writes.slice(1)) sock.write(w);
  }
  const wasClosed = await closed;
  sock.destroy();
  return { received: Buffer.concat(chunks), closed: wasClosed };
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
