/**
 * Test-only helper: build the hostexec intercept artifacts before a suite that
 * can only observe them through the built binary.
 *
 * Not imported by production code. It lives here rather than inside
 * `intercept/` so the zig package directory stays pure zig, and outside
 * `intercept_path.ts` so nothing that ships can spawn a compiler.
 */

import { fileURLToPath } from "node:url";

/**
 * Keep the dev artifacts in step with the source before measuring them.
 *
 * `hostexec_intercept.so`, `nas-hostexec-client`, and `nas-hostexec-gateway`
 * are built from one Zig graph and together implement the protocol boundary.
 * Forgetting `zig build` makes a suite **reproduce bugs that are already fixed
 * in the source** — it would exercise yesterday's client, interceptor, or
 * gateway while the reader assumes it exercises the diff. The mask-filter
 * suite hit exactly that (see
 * `mask_filter_integration_test.ts`), so building is the test's job here too.
 *
 * An mtime comparison is not a substitute: `zig build` leaves the artifact
 * untouched when the output is byte-identical, so a correctly rebuilt binary
 * still looks "old".
 *
 * Two environments deliberately skip the build:
 *   - `NAS_ASSET_DIR` (bundled mode): nix built all three artifacts from this
 *     same source already.
 *   - no `zig` on PATH (outside the devShell): nothing can be built, and
 *     failing here would not help anyone fix it. The caller's `skipIf` then
 *     reports the missing artifact as a skip rather than a silent pass.
 */
export async function buildInterceptArtifactsForDev(): Promise<void> {
  if (process.env.NAS_ASSET_DIR) return;
  await buildInterceptArtifactsFromSource();
}

/**
 * Build the three artifacts into `intercept/zig-out/`, bundled mode or not.
 *
 * Only for a suite that reads `zig-out/` directly instead of through
 * `resolveInterceptLibPath`. Skipping the build in bundled mode is right for
 * everyone who resolves the artifact the same way `nas` does — nix already
 * built what they will read. A suite that measures the *source tree's* build
 * output gets no such guarantee from `NAS_ASSET_DIR`: it would silently grade
 * whatever `zig-out/` happened to hold from an earlier build, so a
 * regression reintroduced today can still pass.
 */
export async function buildInterceptArtifactsFromSource(): Promise<void> {
  if (Bun.which("zig") === null) return;
  const srcDir = fileURLToPath(new URL("./intercept/", import.meta.url));
  const proc = Bun.spawn(["zig", "build"], {
    cwd: srcDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`zig build failed in ${srcDir} (exit ${code}):\n${stderr}`);
  }
}
