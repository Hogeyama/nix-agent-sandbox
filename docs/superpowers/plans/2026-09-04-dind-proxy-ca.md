# Proxy CA for the DinD Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the DinD sidecar's daemon the session proxy's CA certificate, so image pulls stop failing TLS verification, without putting the CA's private key inside a container the agent controls.

**Architecture:** The certificate path gets one definition in a pure helper, travels on `ProxyState` as a file path (never the directory, which also holds the private key), and reaches the sidecar as a `--mount type=bind` entry plus `SSL_CERT_DIR`.

**Tech Stack:** Bun, TypeScript (strict), Effect, Docker CLI.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-04-dind-proxy-ca-design.md`. Read it before Task 1.
- Read `.claude/skills/security-constraints/SKILL.md`. C1 governs this work: the CA private key must never be mounted into a container. Mount the certificate **file**; never its parent directory.
- Read `.claude/skills/effect-separation/SKILL.md` and `.claude/skills/test-policy/SKILL.md`.
- Use `--mount` (the `mounts` option on `dockerRunDetached`), never `-v`, for the certificate. `-v` with a missing source silently creates a directory instead of failing, which loses trust silently and poisons the CA directory so the certificate is never regenerated.
- Runtime is Bun with `bun:test`. Unit tests must not reach a live Docker daemon.
- While iterating, run single unit test files and `bun run check`. Run `bun run test` at most once, at the end of Task 3. It needs an interactive hostexec approval, so ask before running it.
- Known pre-existing failures, not yours: 5 `bun run check` errors in `src/ui/markdownView.ts`; `src/docker/mitmproxy/nas_addon_test.ts` (1 python case); `src/stages/maskfs/mask_filter_integration_test.ts` (stale zig binary).
- For each test you write, break the production code it covers and confirm it fails, then restore. Record that in your report.

## Task Order

1 → 2 → 3. Task 2 consumes the state field Task 1 adds. Task 4 is independent.

---

### Task 1: One definition of the certificate path, published on ProxyState

**Files:**
- Modify: `src/network/registry.ts` (add the helper), `src/stages/proxy/ca_service.ts:49`, `src/stages/proxy/stage.ts:209`
- Modify: `src/pipeline/state.ts` (`ProxyState`), `src/stages/proxy/stage.ts` (publish it)
- Test: `src/stages/proxy/stage_test.ts` (`:361`), `src/pipeline/types_test.ts` (`:210-213`, `:326-329`), `src/cli_test.ts` (`:317`, `:343`)

**Interfaces:**
- Produces: `caCertFilePath(paths): string` returning `${paths.caCertDir}/mitmproxy-ca-cert.pem`; `ProxyState.caCertPath: string` (required).

- [ ] **Step 1: Write the failing test**

In `src/stages/proxy/stage_test.ts`, assert the published state carries the certificate file:

```typescript
test("planProxy: publishes the CA certificate file path, not its directory", () => {
  const plan = planProxy(makeProxyInput());

  const published = plan.outputOverrides.proxy?.caCertPath;
  expect(published).toBe(caCertFilePath(plan.runtimePaths));
  expect(published).toMatch(/\/mitmproxy-ca-cert\.pem$/);
  expect(published).not.toBe(plan.runtimePaths.caCertDir);
});
```

Use whatever input helper and plan accessor the neighbouring tests in that file already use; read them first.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/stages/proxy/stage_test.ts`
Expected: FAIL — `caCertPath` does not exist on the state.

- [ ] **Step 3: Add the helper**

In `src/network/registry.ts`, beside the other path builders:

```typescript
/**
 * The proxy CA's certificate, without its private key.
 *
 * mitmproxy's cert store keeps the key in sibling files (`mitmproxy-ca.pem`,
 * `mitmproxy-ca.p12`), so callers that hand this path to a container must pass
 * the file and never its directory.
 */
export function caCertFilePath(paths: { readonly caCertDir: string }): string {
  return path.join(paths.caCertDir, "mitmproxy-ca-cert.pem");
}
```

Replace the literal at `ca_service.ts:49` and the `caCertMount.source` at `proxy/stage.ts:209` with calls to it.

- [ ] **Step 4: Publish it**

Add `readonly caCertPath: string;` to `ProxyState` in `src/pipeline/state.ts`, and set it from `caCertFilePath(runtimePaths)` where `planProxy` builds the proxy slice.

- [ ] **Step 5: Fix the construction sites**

Run: `bun run check`

Add `caCertPath` to every `ProxyState` literal the compiler flags. Known: `src/pipeline/types_test.ts:210-213`, `:326-329`, `src/cli_test.ts:317`, `:343`. Trust the compiler over this list.

- [ ] **Step 6: Verify**

Run: `bun test src/stages/proxy/stage_test.ts src/pipeline/types_test.ts src/cli_test.ts`
Expected: PASS. Then break the helper (return `caCertDir`) and confirm the new test fails; restore.

- [ ] **Step 7: Commit**

```bash
git add src/network/registry.ts src/stages/proxy/ca_service.ts src/stages/proxy/stage.ts src/pipeline/state.ts src/stages/proxy/stage_test.ts src/pipeline/types_test.ts src/cli_test.ts
git commit -F - <<'EOF'
refactor(proxy): give the CA certificate path one definition

The path was spelled out where the certificate is generated and again where it
is mounted into the agent, and a third consumer was about to be added. Two
spellings of a filename that must match is a defect waiting for someone to
rename one of them.

The pipeline state carries the certificate's file path rather than its
directory. mitmproxy's cert store keeps the CA private key in sibling files, so
a consumer handed the directory would mount the key without noticing; offering
only the file makes the safe thing the available thing.
EOF
```

---

### Task 2: Mount the certificate into the sidecar and point the daemon at it

**Files:**
- Modify: `src/docker/dind.ts` (`DIND_CA_MOUNT_PATH`, `buildDindSidecarEnv`, `startDindSidecar`, `runDindSidecar`, `EnsureDindSidecarParams`, the three call sites at `:99`, `:132`, `:165`)
- Modify: `src/stages/dind/dind_service.ts` (`DindSidecarOpts`), `src/stages/dind/stage.ts` (`DindPlan`)
- Test: `src/stages/dind/stage_test.ts`

**Interfaces:**
- Consumes: `ProxyState.caCertPath` from Task 1.
- Produces: `DIND_CA_MOUNT_PATH = "/etc/nas-ca"`; `buildDindSidecarMounts(caCertPath)` returning the `mounts` array for `dockerRunDetached`; `startDindSidecar`/`runDindSidecar` take `proxy: { proxyEndpoint: string; caCertPath: string }` in place of the positional `proxyEndpoint`.

- [ ] **Step 1: Write the failing tests**

```typescript
test("buildDindSidecarMounts: binds the certificate file read-only", () => {
  const mounts = buildDindSidecarMounts("/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem");

  expect(mounts).toEqual([
    {
      source: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
      target: `${DIND_CA_MOUNT_PATH}/nas-proxy.crt`,
      mode: "ro",
    },
  ]);
});

test("buildDindSidecarMounts: never binds the certificate's parent directory", () => {
  const certPath = "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem";
  const parent = "/run/nas/mitmproxy-ca";

  const sources = buildDindSidecarMounts(certPath).map((m) => m.source);

  // The parent directory also holds mitmproxy-ca.pem and mitmproxy-ca.p12,
  // which carry the CA's private key. Compare sources exactly: a substring
  // check would pass on the very mount it is meant to forbid.
  expect(sources.filter((s) => s === certPath)).toHaveLength(1);
  expect(sources).not.toContain(parent);
});

test("buildDindSidecarEnv: points Go's trust search at the mount directory", () => {
  const env = buildDindSidecarEnv({
    proxyEndpoint: "http://sid:tok@nas-proxy:8080",
    caCertPath: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
  });

  expect(env.SSL_CERT_DIR).toBe(DIND_CA_MOUNT_PATH);
  expect(env.SSL_CERT_FILE).toBeUndefined();
});
```

`SSL_CERT_FILE` must stay unset: setting it would replace the image's own certificate bundle instead of adding to it.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test src/stages/dind/stage_test.ts`
Expected: FAIL — `buildDindSidecarMounts` does not exist and `buildDindSidecarEnv` takes a string.

- [ ] **Step 3: Add the constant and the mount builder**

In `src/docker/dind.ts`, beside `DIND_IMAGE`:

```typescript
/**
 * Where the sidecar sees the proxy's CA certificate.
 *
 * SSL_CERT_DIR makes Go read every file in this directory, so it must hold
 * nothing else. A path the image does not otherwise use satisfies that.
 */
export const DIND_CA_MOUNT_PATH = "/etc/nas-ca";

/**
 * Bind the proxy's CA certificate into the sidecar.
 *
 * `--mount` rather than `-v` on purpose: given a source that does not exist,
 * `-v` creates a directory there instead of failing, which would leave the
 * daemon silently untrusting and leave a directory named
 * `mitmproxy-ca-cert.pem` behind — enough for the CA service's existence check
 * to treat the certificate as present forever.
 */
export function buildDindSidecarMounts(
  caCertPath: string,
): Array<{ source: string; target: string; mode: "ro" }> {
  return [
    {
      source: caCertPath,
      target: `${DIND_CA_MOUNT_PATH}/nas-proxy.crt`,
      mode: "ro",
    },
  ];
}
```

The element type is declared at `src/docker/client.ts:317-325` as
`string | { source; target; mode?; type?: "bind" | "volume" }`. Pass
`type: "bind"` explicitly rather than relying on the default, so the encoded
flag is the one whose missing-source behavior this design depends on. Update the
two tests above to expect that field.

- [ ] **Step 4: Set the variable**

Change `buildDindSidecarEnv` to take `proxy: { proxyEndpoint: string; caCertPath: string }` and add `SSL_CERT_DIR: DIND_CA_MOUNT_PATH` to the returned record. Leave the existing proxy variables and `DOCKER_TLS_CERTDIR` alone.

- [ ] **Step 5: Thread the value**

Replace the positional `proxyEndpoint: string` on `startDindSidecar` and `runDindSidecar` with the same object parameter, and pass `mounts: buildDindSidecarMounts(proxy.caCertPath)` to `dockerRunDetached` in `runDindSidecar`. Update all three `runDindSidecar` call sites (`dind.ts:99`, `:132`, `:165`) — the two cache-reset retry paths included; the comment at `:72-75` records the same trap.

Add `caCertPath` to `EnsureDindSidecarParams`, to `DindSidecarOpts` in `src/stages/dind/dind_service.ts`, and to `DindPlan` in `src/stages/dind/stage.ts`, sourced from `input.proxy.caCertPath`.

- [ ] **Step 6: Verify**

Run: `bun test src/stages/dind/stage_test.ts` then `bun run check`
Expected: PASS, and no new check errors.

Break each new test in turn — return the parent directory from the mount builder, drop `SSL_CERT_DIR` — confirm the failures, restore.

- [ ] **Step 7: Commit**

```bash
git add src/docker/dind.ts src/stages/dind/dind_service.ts src/stages/dind/stage.ts src/stages/dind/stage_test.ts
git commit -F - <<'EOF'
fix(dind): give the sidecar's daemon the proxy's CA certificate

The sidecar's daemon is routed through a TLS-terminating proxy but was never
given the CA behind it, so every registry pull failed verification with
"certificate signed by unknown authority" and only images already in the cache
volume could run. The gap dates to the mitmproxy migration, which gave the agent
container a certificate and left the sidecar out.

SSL_CERT_DIR carries it: Go reads that directory in addition to the image's own
bundle, so no root, no entrypoint override and no package in an image this
project does not control are needed. Measured before choosing it — a directory
holding only this certificate is enough to verify a proxied connection.

The bind uses --mount rather than -v because -v does not fail on a missing
source; it creates a directory there. That would leave the daemon silently
untrusting and leave behind a directory named mitmproxy-ca-cert.pem, which the
CA service's existence check would then treat as a generated certificate
forever, breaking the agent's own mount with it.

Only the certificate is mounted. Its directory also holds mitmproxy-ca.pem and
an unencrypted mitmproxy-ca.p12, both carrying the CA's private key, and the
agent reaches this daemon without restriction.
EOF
```

---

### Task 3: Integration coverage

**Files:**
- Modify: `src/stages/dind/integration_test.ts`

The existing harness cannot serve this: it passes a dummy `proxyEndpoint` (`:134`), stands up no proxy and no `nas-proxy` name, and severs the bridge — which is why its other cases side-load images (`:180-184`).

- [ ] **Step 1: Write the case**

Follow the standalone mitmproxy pattern at `src/docker/mitmproxy/nas_addon_integration_test.ts:586-640`, without the addon. Read that passage first and reuse its start-and-wait shape.

Shape: create a temp directory, run `mitmdump --mode regular@8080` with it as `confdir` so mitmproxy generates a CA there, start the sidecar with `HTTPS_PROXY` pointed at that container, then assert both directions.

```typescript
test.skipIf(!dindAvailable || !RUNNING_ON_HOST_DOCKER)(
  "DindStage: the sidecar pulls through the proxy with the CA mounted, and fails without it",
  async () => {
    // ... start mitmproxy on a generated confdir, capture its container name
    // and the generated <confdir>/mitmproxy-ca-cert.pem

    // negative control first: without the mount the pull must fail on x509
    const without = await pullInSidecar(sidecarWithoutCa, "alpine:3.19");
    expect(without.exitCode).not.toEqual(0);
    expect(without.output).toMatch(/x509|certificate/i);

    // with the mount it must succeed
    const withCa = await pullInSidecar(sidecarWithCa, "alpine:3.19");
    expect(
      withCa.exitCode,
      `pull failed with the CA mounted. Output:\n${withCa.output}`,
    ).toEqual(0);
  },
  90_000,
);
```

The timeout argument is required — the two sibling cases in this file pass `90_000` and a case that starts a sidecar runs well past bun:test's five-second default.

The negative control is what makes the positive assertion mean anything: without it, a pull that succeeds for some unrelated reason would read as proof.

Generate every container, volume and network name; do not reuse the file's fixed `test-session-1234`. Clean up in `finally` on every path, including the mitmproxy container and the temp directory.

- [ ] **Step 2: Type check**

Run: `bun run check`
Expected: no new errors.

- [ ] **Step 3: Ask before running the suite**

`bun run test` needs an interactive hostexec approval and takes about three and a half minutes. Ask the user to approve it, then run it once. Report every failure and whether it is one of the three known pre-existing ones.

- [ ] **Step 4: Commit**

```bash
git add src/stages/dind/integration_test.ts
git commit -F - <<'EOF'
test(dind): cover pulling through the proxy with the CA mounted

Whether the daemon trusts the proxy's CA is not visible from the arguments the
stage builds — it is a property of what the daemon does with them. This case
stands up a standalone mitmproxy, points the sidecar at it, and pulls.

The existing harness could not host this: it passes a dummy proxy endpoint,
stands up no proxy, and severs the bridge, which is why its other cases
side-load images instead of pulling.

The negative control runs first. A pull that succeeds proves nothing unless the
same pull is known to fail without the certificate.
EOF
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md` (the `docker.enable` section), `docs/todo/security.md`

- [ ] **Step 1: README**

The `docker.enable` section documents the bind-mount and port constraints but says nothing about registry access. Add that images are pulled through the session proxy, so a registry must be permitted by `network.allowlist` for a pull to succeed, and name the failure a user sees when it is not.

Follow the user's writing rules, which override defaults: no 体言止め, no 和語の動詞 in vague senses (prefer 漢語+する), and no emphasis used as a heading. Match the surrounding Japanese register.

- [ ] **Step 2: security.md**

Record that the sidecar now holds the proxy's CA certificate and deliberately not its private key, that the key files are `mitmproxy-ca.pem` and an unencrypted `mitmproxy-ca.p12`, and that their 0600 mode is not a boundary here because the sidecar's `rootless` user is the same uid that owns them.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/todo/security.md
git commit -F - <<'EOF'
docs: describe registry access through the proxy, and what the sidecar trusts

The docker.enable section covered bind mounts and port collisions but left the
reader to discover that pulls traverse the session proxy, so a registry missing
from the allowlist fails in a way that reads like a network fault.

Records which files the CA directory keeps out of the sidecar and why their
mode is not the thing keeping them out.
EOF
```

---

## Manual Verification

After Task 4, one check the suite cannot make. Restart nas with `docker.enable = true` and, inside the agent, run `docker pull alpine:3.19`. It should succeed. Amend the spec's Verified Behavior section with the result.
