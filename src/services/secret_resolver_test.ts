import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeSecretResolverService } from "./secret_resolver.ts";

describe("SecretResolverService", () => {
  test("異なる source を並列に解決する", async () => {
    const firstCanFinish = Promise.withResolvers<void>();
    let secondStarted = false;
    const service = makeSecretResolverService(async (source) => {
      if (source === "command:first") {
        await firstCanFinish.promise;
      } else {
        secondStarted = true;
        firstCanFinish.resolve();
      }
      return `${source}-value`;
    });

    const resolved = await Effect.runPromise(
      service.resolveRegistry(
        {
          first: { from: "command:first" },
          second: { from: "command:second" },
        },
        {},
      ),
    );

    expect(secondStarted).toBeTrue();
    expect(resolved).toEqual({
      first: ["command:first-value"],
      second: ["command:second-value"],
    });
  }, 500);

  test("同じセッションでは同じ source を一度だけ解決する", async () => {
    const calls: string[] = [];
    const service = makeSecretResolverService(async (source) => {
      calls.push(source);
      return source === "lines:/secrets" ? ["alpha", "bravo"] : "token";
    });

    const first = await Effect.runPromise(
      service.resolveRegistry(
        {
          github: { from: "command:gh auth token" },
          githubAgain: { from: "command:gh auth token" },
          file: { from: "lines:/secrets" },
        },
        {},
      ),
    );
    const second = await Effect.runPromise(
      service.resolveRegistry(
        {
          github: { from: "command:gh auth token" },
          file: { from: "lines:/secrets" },
        },
        {},
      ),
    );

    expect(first).toEqual({
      github: ["token"],
      githubAgain: ["token"],
      file: ["alpha", "bravo"],
    });
    expect(second).toEqual({
      github: ["token"],
      file: ["alpha", "bravo"],
    });
    expect(calls).toEqual(["command:gh auth token", "lines:/secrets"]);
  });
});
