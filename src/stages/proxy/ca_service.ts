/**
 * CaService — Effect-based abstraction over mitmproxy CA certificate generation.
 *
 * Ensures the mitmproxy CA cert exists in the runtime directory so it can be
 * mounted into agent containers and trusted via update-ca-certificates.
 *
 * Live implementation uses Bun.spawn to run `docker run --rm` since DockerService
 * only exposes runDetached/runInteractive (not a blocking run). This is acceptable
 * because the service IS the IO boundary (D1 wrapper per effect-separation rules).
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { DockerService } from "../../services/docker.ts";
import { FsService } from "../../services/fs.ts";

// ---------------------------------------------------------------------------
// CaService tag
// ---------------------------------------------------------------------------

export class CaService extends Context.Tag("nas/CaService")<
  CaService,
  {
    readonly ensureCaCert: (
      paths: NetworkRuntimePaths,
      proxyImage: string,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const CaServiceLive: Layer.Layer<
  CaService,
  never,
  FsService | DockerService
> = Layer.effect(
  CaService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const docker = yield* DockerService;

    return CaService.of({
      ensureCaCert: (paths, proxyImage) =>
        Effect.gen(function* () {
          const certPath = `${paths.caCertDir}/mitmproxy-ca-cert.pem`;
          const certExists = yield* fs.exists(certPath);

          if (certExists) return;

          yield* docker.ensureImage(proxyImage).pipe(Effect.orDie);
          yield* Effect.tryPromise({
            try: async () => {
              const uid = process.getuid?.() ?? 0;
              const gid = process.getgid?.() ?? 0;
              const proc = Bun.spawn(
                [
                  "docker",
                  "run",
                  "--rm",
                  "--user",
                  `${uid}:${gid}`,
                  "-v",
                  `${paths.caCertDir}:/home/mitmproxy/.mitmproxy`,
                  "--entrypoint",
                  "python3",
                  proxyImage,
                  "-c",
                  "from mitmproxy.certs import CertStore; CertStore.from_store('/home/mitmproxy/.mitmproxy', 'mitmproxy', 2048)",
                ],
                { stdout: "ignore", stderr: "pipe" },
              );
              const exitCode = await proc.exited;
              if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text();
                throw new Error(
                  `CA cert generation failed (exit ${exitCode}): ${stderr}`,
                );
              }
            },
            catch: (e) =>
              new Error(
                `CaService: ${e instanceof Error ? e.message : String(e)}`,
              ),
          }).pipe(Effect.orDie);
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface CaServiceFakeConfig {
  readonly ensureCaCert?: (
    paths: NetworkRuntimePaths,
    proxyImage: string,
  ) => Effect.Effect<void>;
}

export function makeCaServiceFake(
  overrides: CaServiceFakeConfig = {},
): Layer.Layer<CaService> {
  return Layer.succeed(
    CaService,
    CaService.of({
      ensureCaCert: overrides.ensureCaCert ?? (() => Effect.void),
    }),
  );
}
