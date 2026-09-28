import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FsService, makeFsServiceFake } from "../../services/fs.ts";
import {
  SessionHooksService,
  SessionHooksServiceLive,
} from "./hooks_service.ts";

const PLAN = {
  sessionDir: "/runtime/session-hooks/sess_test",
  agents: ["claude", "copilot", "codex"] as const,
};

test("settings and executable shim are readable, while their host parent stays private; scope removes all assets", async () => {
  const fs = makeFsServiceFake();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* SessionHooksService;
        yield* service.prepare(PLAN);
        expect(fs.store.get(PLAN.sessionDir)?.mode).toBe(0o700);
        expect(fs.store.get(`${PLAN.sessionDir}/assets`)?.mode).toBe(0o755);
        expect(fs.store.get(`${PLAN.sessionDir}/assets/report`)?.mode).toBe(
          0o755,
        );
        for (const file of ["claude.json", "copilot.json", "codex.toml"])
          expect(fs.store.get(`${PLAN.sessionDir}/assets/${file}`)?.mode).toBe(
            0o644,
          );
      }).pipe(
        Effect.provide(SessionHooksServiceLive.pipe(Layer.provide(fs.layer))),
      ),
    ),
  );
  expect(fs.store.size).toBe(0);
});

test("a settings write failure cleans up partially generated files", async () => {
  const fs = makeFsServiceFake();
  const failingFs = Layer.effect(
    FsService,
    Effect.gen(function* () {
      const service = yield* FsService;
      return {
        ...service,
        writeFile: (
          file: string,
          content: string | Uint8Array,
          opts?: { mode?: number },
        ) =>
          file.endsWith("copilot.json")
            ? Effect.die("disk full")
            : service.writeFile(file, content, opts),
      };
    }),
  ).pipe(Layer.provide(fs.layer));
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* SessionHooksService;
        yield* service.prepare(PLAN);
      }).pipe(
        Effect.provide(SessionHooksServiceLive.pipe(Layer.provide(failingFs))),
      ),
    ),
  );
  expect(exit._tag).toBe("Failure");
  expect(fs.store.size).toBe(0);
});
