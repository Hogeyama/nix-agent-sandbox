// Invoked in a fresh process so NODE_EXTRA_CA_CERTS trusts only our test CA.
import { strict as assert } from "node:assert";
import { createServer } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createMitmCA,
  disposeMitmCA,
} from "../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";
import { mintLeafCert } from "../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js";
import { buildCredentials, type CredentialOverwrite } from "../credentials.ts";
import { decide } from "../policy.ts";
import { assertCredentialOverwritePatched } from "../selfcheck.ts";

assertCredentialOverwritePatched();
const ca = createMitmCA({
  caCertPath: process.env.TEST_CA_CERT,
  caKeyPath: process.env.TEST_CA_KEY,
});
const leaf = mintLeafCert(ca, "localhost");
const seen: Array<{ headers: Record<string, unknown>; body: string }> = [];
const upstream = createServer(
  { key: leaf.keyPem, cert: leaf.certPem },
  async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.end("upstream-ok");
  },
);
const sockets = new Set<Duplex>();
upstream.on("connection", (s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});
let release: ((allow: boolean) => void) | undefined;
let waiting: (() => void) | undefined;
let mode: "normal" | "review" | "throw" | "anonymous" = "normal";
const credential = buildCredentials(
  {
    localhost: {
      credential: {
        env: "FAKE_FORWARDING_KEY",
        header: "authorization",
        scheme: "Bearer",
      },
    },
  },
  { FAKE_FORWARDING_KEY: "host-secret-test" },
);
process.env.FAKE_FORWARDING_KEY = "host-secret-test";
process.env.FAKE_OTHER_KEY = "other-secret-test";
const clientSockets = new Set<Socket>();
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  cleanupPromise ??= cleanupResources();
  return cleanupPromise;
}
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(1));
});
try {
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const port = (upstream.address() as { port: number }).port;
  const runtime: Parameters<typeof SandboxManager.initialize>[0] & {
    credentials: NonNullable<
      Parameters<typeof SandboxManager.initialize>[0]["credentials"]
    > &
      CredentialOverwrite;
  } = {
    network: {
      allowedDomains: [`localhost:${port}`],
      deniedDomains: [],
      strictAllowlist: true,
      tlsTerminate: { caCertPath: ca.certPath, caKeyPath: ca.keyPath },
      filterRequest: async (req) => {
        // Only the fixture translates its ephemeral listener port to the
        // production port invariant. Every method/header decision is real.
        const url = req.url.replace(`:${port}/`, "/");
        const decision = decide(
          { method: req.method, url, headers: req.headers },
          { trustedGitHubRepos: [], hosts: { localhost: {} } },
          mode === "anonymous" ? {} : credential.policyHeaders,
        );
        if (decision.action !== "allow") return { action: "deny" };
        if (mode === "review") {
          waiting?.();
          return new Promise<{ action: "allow" | "deny" }>((resolve) => {
            release = (allow) => resolve({ action: allow ? "allow" : "deny" });
          });
        }
        return decision;
      },
    },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
    credentials: {
      envVars: [
        ...credential.maskedEnvVars,
        { name: "FAKE_OTHER_KEY", mode: "mask", injectHosts: [] },
      ],
      overwriteHeaders: (headers, host) => {
        if (mode === "throw")
          throw new Error("host-secret-test must never appear in errors");
        credential.overwrite(headers, host);
      },
    },
  };
  await SandboxManager.initialize(runtime);
  // Exercise environment masking through the real wrap path. Never execute
  // the wrapper: tests need no bubblewrap privileges or external service.
  const wrapped = await SandboxManager.wrapWithSandbox("true");
  const entries = [...SandboxManager.getSentinelRegistry().entries()];
  credential.assertMasked(entries);
  const sentinel = entries.find(
    ([, value]) => value === "host-secret-test",
  )?.[0];
  const foreign = entries.find(
    ([, value]) => value === "other-secret-test",
  )?.[0];
  assert(
    sentinel &&
      foreign &&
      wrapped.includes(sentinel) &&
      !wrapped.includes("host-secret-test"),
  );
  const matches = (host: string, pattern: string) => host === pattern;
  assert.deepEqual(
    SandboxManager.getSentinelRegistry().sentinelsForHost("localhost", matches),
    [],
  );

  const proxyPort = SandboxManager.getProxyPort();
  assert(proxyPort !== undefined);
  async function send(
    extra = "",
    body = "",
    method = "POST",
    chunked = false,
    path = "/echo",
  ): Promise<string> {
    assert(proxyPort !== undefined);
    const raw = netConnect(proxyPort, "127.0.0.1");
    clientSockets.add(raw);
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    const auth = Buffer.from(
      `srt:${SandboxManager.getProxyAuthToken()}`,
    ).toString("base64");
    raw.write(
      `CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const onData = (b: Buffer) => {
        if (b.toString().includes("\r\n\r\n")) {
          raw.off("data", onData);
          assert(b.toString().startsWith("HTTP/1.1 200"));
          resolve();
        }
      };
      raw.on("data", onData);
      raw.once("error", reject);
    });
    const tls = tlsConnect({
      socket: raw,
      servername: "localhost",
      ca: ca.certPem,
    });
    clientSockets.add(tls);
    await new Promise<void>((resolve, reject) => {
      tls.once("secureConnect", resolve);
      tls.once("error", reject);
    });
    const chunks: Buffer[] = [];
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        tls.destroy();
        reject(
          new Error(
            `forwarding fixture timed out: ${Buffer.concat(chunks).toString()}`,
          ),
        );
      }, 5000);
      tls.on("data", (b: Buffer) => chunks.push(b));
      tls.once("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString());
      });
      tls.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    tls.write(
      `${method} ${path} HTTP/1.1\r\nHost: attacker.invalid\r\n${extra}${chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${Buffer.byteLength(body)}`}\r\nConnection: close${extra.includes("X-Connection-Test") ? ", authorization, x-api-key" : ""}\r\n\r\n`,
    );
    if (chunked) {
      const split = body.indexOf(sentinel ?? "") + 10;
      for (const part of [body.slice(0, split), body.slice(split)]) {
        tls.write(`${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`);
        await new Promise((r) => setTimeout(r, 10));
      }
      tls.write("0\r\n\r\n");
    } else tls.write(body);
    const reply = await response;
    tls.destroy();
    raw.destroy();
    return reply;
  }
  for (const headers of [
    "",
    "Authorization: Bearer attacker\r\n",
    `Authorization: ${sentinel}\r\n`,
    `Authorization: ${foreign}\r\n`,
    "Authorization: first\r\nauthorization: second\r\nX-Api-Key: first\r\nx-api-key: second\r\n",
    "Authorization: attacker\r\nX-Api-Key: attacker\r\nX-Connection-Test: yes\r\n",
  ]) {
    const body: string = JSON.stringify({ token: sentinel, other: foreign });
    assert.match(
      await send(`${headers}X-Echo: ${sentinel}\r\n`, body),
      /^HTTP\/1\.1 200/,
    );
    const got = seen.at(-1);
    assert(got);
    assert.equal(got.headers.authorization, "Bearer host-secret-test");
    assert.equal(got.headers["x-api-key"], undefined);
    assert.equal(got.headers["x-echo"], sentinel);
    assert.equal(got.headers.host, `localhost:${port}`);
    assert.equal(got.body, body);
  }
  for (const method of ["POST", "GET"]) {
    const body: string = `before:${sentinel}:after:${foreign}`;
    assert.match(await send("", body, method, true), /^HTTP\/1\.1 200/);
    assert.equal(seen.at(-1)?.body, body);
  }
  let before = seen.length;
  for (const headers of ["Cookie: session=attacker\r\n"])
    assert.match(await send(headers), /^HTTP\/1\.1 403/);
  assert.equal(seen.length, before);
  assert.match(
    await send("", "", "GET", false, "/echo?access_token=attacker"),
    /^HTTP\/1\.1 403/,
  );
  assert.equal(seen.length, before);
  mode = "anonymous";
  assert.match(await send("Authorization: attacker\r\n"), /^HTTP\/1\.1 403/);
  assert.equal(seen.length, before);
  mode = "throw";
  const failed = await send("Authorization: attacker\r\n");
  assert.match(failed, /^HTTP\/1\.1 403/);
  assert(!failed.includes("host-secret-test"));
  assert.equal(seen.length, before);
  for (const approved of [false, true]) {
    mode = "review";
    const held = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const pending = send("Authorization: attacker\r\n");
    await held;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, before);
    assert(release);
    release(approved);
    assert.match(
      await pending,
      approved ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 403/,
    );
    if (approved) {
      before++;
      assert.equal(
        seen.at(-1)?.headers.authorization,
        "Bearer host-secret-test",
      );
    }
    assert.equal(seen.length, before);
  }
  console.log(
    "patched manager forwarding: auth overwrite, untouched data, deny/review, error redaction verified",
  );
} finally {
  await cleanup();
}
async function cleanupResources() {
  release?.(false);
  for (const s of clientSockets) s.destroy();
  await SandboxManager.reset();
  for (const s of sockets) s.destroy();
  if (upstream.listening)
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await disposeMitmCA(ca);
}
