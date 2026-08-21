# Local Proxy CONNECT Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop established CONNECT tunnel teardown from printing misleading local-proxy errors or injecting a plaintext HTTP response.

**Architecture:** Track the CONNECT protocol phase beside the upstream response buffer. Before a successful upstream response, preserve the HTTP `502` setup-failure path; afterward, treat upstream socket errors as byte-tunnel termination and only destroy the downstream socket.

**Tech Stack:** Bun, `node:http`, `node:net`, `bun:test`, Docker for Bun 1.4 red/green verification

## Global Constraints

- Follow `AGENTS.md` and `skills/test-policy/SKILL.md`.
- Change only HTTPS CONNECT upstream-error handling in `local-proxy.mjs` and its colocated integration test.
- Before tunnel establishment, retain stderr logging and `502 Bad Gateway`.
- After tunnel establishment, write neither stderr nor protocol bytes; close the downstream socket.
- Do not pin or downgrade Bun in this change.
- Use Bun 1.4 from the built `nas-sandbox` image to prove the regression test fails before the fix and passes after it.

---

### Task 1: Make CONNECT error handling phase-aware

**Files:**
- Modify: `src/docker/local_proxy_integration_test.ts`
- Modify: `src/docker/embed/local-proxy.mjs:68-120`

**Interfaces:**
- Consumes: the existing `startLocalProxy()`, `killProcess()`, and CONNECT forwarding behavior
- Produces: phase-aware upstream error handling with no new exported API

**Task-specific review focus:**
- Verify every upstream error branch sends HTTP only before a successful CONNECT response.
- Verify the test observes both user-visible channels: stderr and downstream bytes.
- Verify process and socket cleanup completes on assertion failure.

- [ ] **Step 1: Add the failing established-tunnel reset test**

Add a test after the existing CONNECT forwarding test. The mock upstream accepts
CONNECT, sends `200`, and resets after the downstream half-closes. Capture both
stderr and any bytes received after the successful handshake:

```ts
test("local-proxy: established CONNECT teardown stays silent", async () => {
  const upstreamPort = 19903;
  const proxyPort = 18090;
  const listener = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      socket.once("end", () => socket.resetAndDestroy());
    });
  });
  await new Promise<void>((resolve) => {
    listener.listen(upstreamPort, "127.0.0.1", resolve);
  });

  const process = await startLocalProxy(
    `http://sess_abc:token123@127.0.0.1:${upstreamPort}`,
    proxyPort,
    { NAS_FORWARD_PORTS: "" },
  );
  const afterHandshake: Buffer[] = [];

  try {
    const client = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(
        { host: "127.0.0.1", port: proxyPort },
        () => resolve(socket),
      );
      socket.once("error", reject);
    });
    client.write(
      "CONNECT target.example.com:443 HTTP/1.1\r\n" +
        "Host: target.example.com:443\r\n\r\n",
    );
    const response = await new Promise<string>((resolve) => {
      client.once("data", (data) => resolve(data.toString()));
    });
    expect(response).toContain("200");

    client.on("data", (data) => afterHandshake.push(data));
    client.end();
    await new Promise<void>((resolve) => client.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await killProcess(process);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }

  const stderr = await new Response(process.stderr).text();
  expect(stderr).toEqual("");
  expect(Buffer.concat(afterHandshake).toString()).toEqual("");
});
```

The implementer may adjust event-listener cleanup or waiting mechanics if Bun
requires it, but must retain the same externally observed assertions.

- [ ] **Step 2: Run the regression under Bun 1.4 and verify RED**

Run:

```bash
docker run --rm \
  --entrypoint /usr/local/bin/bun \
  --volume "$PWD:/workspace:ro" \
  --workdir /workspace \
  nas-sandbox \
  test src/docker/local_proxy_integration_test.ts \
  --test-name-pattern "established CONNECT teardown"
```

Expected: FAIL because the current handler writes `CONNECT upstream error` to
stderr and may inject `HTTP/1.1 502 Bad Gateway` after the successful CONNECT
response.

- [ ] **Step 3: Preserve the pre-establishment failure contract**

Add a CONNECT-specific characterization test using an unused upstream port. It
must send a CONNECT request through local-proxy, receive `502 Bad Gateway`, and
observe `CONNECT upstream error` on stderr. This test is expected to pass before
and after the implementation; it protects the branch that the fix must retain.

```ts
test("local-proxy: CONNECT setup failure returns 502", async () => {
  const proxyPort = 18091;
  const process = await startLocalProxy(
    "http://sess_abc:token123@127.0.0.1:19904",
    proxyPort,
    { NAS_FORWARD_PORTS: "" },
  );

  try {
    const client = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(
        { host: "127.0.0.1", port: proxyPort },
        () => resolve(socket),
      );
      socket.once("error", reject);
    });
    client.write(
      "CONNECT target.example.com:443 HTTP/1.1\r\n" +
        "Host: target.example.com:443\r\n\r\n",
    );
    const response = await new Promise<string>((resolve) => {
      client.once("data", (data) => resolve(data.toString()));
    });
    expect(response).toContain("502 Bad Gateway");
    client.destroy();
  } finally {
    await killProcess(process);
  }

  const stderr = await new Response(process.stderr).text();
  expect(stderr).toContain("CONNECT upstream error");
});
```

- [ ] **Step 4: Implement the minimal phase-aware handler**

Record successful establishment before exposing the `200` response to the
downstream client:

```js
let tunnelEstablished = false;

// In the statusCode === 200 branch, before clientSocket.write(...):
tunnelEstablished = true;
```

Split the existing upstream error handler at that boundary:

```js
upstreamSocket.on("error", (err) => {
  if (tunnelEstablished) {
    clientSocket.destroy();
    return;
  }
  console.error(`[local-proxy] CONNECT upstream error: ${err.message}`);
  clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  clientSocket.end();
});
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Bun 1.4 Docker command from Step 2. Expected: the established-tunnel
test passes with empty stderr and no post-handshake bytes.

Run:

```bash
bun test src/docker/local_proxy_integration_test.ts
```

Expected: all local-proxy tests pass, including the pre-establishment CONNECT
failure test.

- [ ] **Step 6: Self-review and commit**

Review `git diff --check` and the full diff. Confirm the change does not touch
HTTP forwarding, CONNECT authentication, or forward-port behavior. Then commit:

```bash
git add src/docker/embed/local-proxy.mjs \
  src/docker/local_proxy_integration_test.ts
git commit
```

Use `git-commit` skill guidance and a `fix(network): ...` subject whose body
records why CONNECT establishment is the protocol boundary.
