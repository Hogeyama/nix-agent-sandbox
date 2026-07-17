import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";
import {
  generateBashWrapper,
  MaskFilterService,
  MaskFilterServiceLive,
} from "./mask_filter_service.ts";

describe("generateBashWrapper", () => {
  test("generates wrapper with filter redirect", () => {
    const script = generateBashWrapper("/opt/nas/mask-filter/nas-mask-filter");
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("NAS_MASK_SECRETS_FILE");
    expect(script).toContain("/opt/nas/mask-filter/nas-mask-filter");
    expect(script).toContain('exec /bin/bash "$@"');
  });
});

describe("MaskFilterServiceLive.prepareMaskFilter", () => {
  test("writes secrets frame and returns mounts + env", async () => {
    const written: Array<{ path: string; data: Uint8Array }> = [];
    const fakeFsLayer = Layer.succeed(
      FsService,
      FsService.of({
        writeFile: (path, data, _opts) =>
          Effect.sync(() => {
            written.push({
              path,
              data:
                data instanceof Uint8Array
                  ? data
                  : new TextEncoder().encode(String(data)),
            });
          }),
        // stub other methods as needed
        mkdir: () => Effect.void,
        readFile: () => Effect.succeed(""),
        chmod: () => Effect.void,
        symlink: () => Effect.void,
        rm: () => Effect.void,
        rename: () => Effect.void,
        stat: () =>
          Effect.succeed({
            isFile: () => true,
            isDirectory: () => false,
            mode: 0o644,
            size: 0,
          } as any),
        exists: () => Effect.succeed(false),
        mkdtemp: () => Effect.succeed("/tmp/fake"),
      }),
    );

    const host = {
      home: "/home/u",
      user: "u",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map([["TEST_SECRET", "hunter2secret"]]),
    } as any;

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MaskFilterService;
          return yield* svc.prepareMaskFilter(
            {
              secretsFramePath: "/tmp/test-secrets",
              filterBinaryHostPath: "/usr/local/bin/nas-mask-filter",
            },
            [{ source: "env:TEST_SECRET" }],
            host,
          );
        }),
        MaskFilterServiceLive.pipe(Layer.provide(fakeFsLayer)),
      ),
    );

    expect(written.length).toBe(1);
    expect(written[0].path).toBe("/tmp/test-secrets");
    expect(result.mounts.length).toBe(2);
    expect(result.envVars.NAS_MASK_SECRETS_FILE).toBe("/run/nas/mask-secrets");
    expect(result.envVars.NAS_MASK_FILTER).toBe(
      "/opt/nas/mask-filter/nas-mask-filter",
    );
    expect(result.bashWrapperScript).toContain("#!/bin/bash");
  });
});
