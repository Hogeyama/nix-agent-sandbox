import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  executeEffect,
  executePlan,
  teardownHandles,
} from "./effects.ts";
import type { ResourceEffect, StagePlan } from "./types.ts";

// ---------------------------------------------------------------------------
// Helper: create a unique temp directory for test isolation
// ---------------------------------------------------------------------------

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "effects_test_" });
  try {
    await fn(dir);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// directory-create
// ---------------------------------------------------------------------------

Deno.test("executeEffect: directory-create creates directory", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/sub/nested`;
    const handle = await executeEffect({
      kind: "directory-create",
      path: target,
      mode: 0o755,
      removeOnTeardown: false,
    });

    assertEquals(handle.kind, "directory-create");
    const stat = await Deno.stat(target);
    assertEquals(stat.isDirectory, true);

    // close should be a no-op since removeOnTeardown=false
    await handle.close();
    const statAfter = await Deno.stat(target);
    assertEquals(statAfter.isDirectory, true);
  });
});

Deno.test("executeEffect: directory-create removeOnTeardown removes directory", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/removable`;
    const handle = await executeEffect({
      kind: "directory-create",
      path: target,
      mode: 0o755,
      removeOnTeardown: true,
    });

    const stat = await Deno.stat(target);
    assertEquals(stat.isDirectory, true);

    await handle.close();

    await assertRejects(
      () => Deno.stat(target),
      Deno.errors.NotFound,
    );
  });
});

// ---------------------------------------------------------------------------
// file-write
// ---------------------------------------------------------------------------

Deno.test("executeEffect: file-write creates file with content and mode", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/test.txt`;
    const handle = await executeEffect({
      kind: "file-write",
      path: target,
      content: "hello world",
      mode: 0o644,
    });

    assertEquals(handle.kind, "file-write");
    const content = await Deno.readTextFile(target);
    assertEquals(content, "hello world");

    const stat = await Deno.stat(target);
    // Check that file mode matches (mask with 0o777 to ignore file type bits)
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o644, true);

    // teardown removes the file
    await handle.close();
    await assertRejects(
      () => Deno.stat(target),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("executeEffect: file-write with executable mode", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/script.sh`;
    const handle = await executeEffect({
      kind: "file-write",
      path: target,
      content: "#!/bin/sh\necho hi",
      mode: 0o755,
    });

    const stat = await Deno.stat(target);
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o755, true);

    await handle.close();
  });
});

// ---------------------------------------------------------------------------
// Unimplemented effects
// ---------------------------------------------------------------------------

Deno.test("executeEffect: unimplemented effects throw", async () => {
  const unimplementedKinds: ResourceEffect[] = [
    {
      kind: "docker-container",
      name: "c",
      image: "i",
      reuseIfRunning: false,
      keepOnTeardown: false,
      args: [],
      envVars: {},
      labels: {},
    },
    { kind: "docker-network", name: "n", connect: [] },
    { kind: "docker-volume", name: "v" },
  ];

  for (const effect of unimplementedKinds) {
    await assertRejects(
      () => executeEffect(effect),
      Error,
      `Effect not yet implemented: ${effect.kind}`,
    );
  }

  // unix-listener with session-broker spec throws a different message
  await assertRejects(
    () =>
      executeEffect({
        kind: "unix-listener",
        id: "ul",
        socketPath: "/tmp/s",
        spec: {
          kind: "session-broker",
          paths: {
            runtimeDir: "/tmp",
            sessionsDir: "/tmp/sessions",
            pendingDir: "/tmp/pending",
            brokersDir: "/tmp/brokers",
            authRouterSocket: "/tmp/auth.sock",
            authRouterPidFile: "/tmp/auth.pid",
            envoyConfigFile: "/tmp/envoy.yaml",
          },
          sessionId: "sid",
          allowlist: [],
          denylist: [],
          promptEnabled: false,
        },
      }),
    Error,
    "unix-listener session-broker not yet implemented",
  );
});

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

Deno.test("executePlan: executes effects in order and returns handles", async () => {
  await withTempDir(async (dir) => {
    const plan: StagePlan = {
      effects: [
        {
          kind: "directory-create",
          path: `${dir}/plandir`,
          mode: 0o755,
          removeOnTeardown: true,
        },
        {
          kind: "file-write",
          path: `${dir}/plandir/file.txt`,
          content: "plan content",
          mode: 0o644,
        },
      ],
      dockerArgs: [],
      envVars: {},
      outputOverrides: {},
    };

    const handles = await executePlan(plan);
    assertEquals(handles.length, 2);
    assertEquals(handles[0].kind, "directory-create");
    assertEquals(handles[1].kind, "file-write");

    // Verify side effects occurred
    const content = await Deno.readTextFile(`${dir}/plandir/file.txt`);
    assertEquals(content, "plan content");

    // Clean up via teardown
    await teardownHandles(handles);
  });
});

Deno.test("executePlan: tears down prior handles when Nth effect fails", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/created`;
    const plan: StagePlan = {
      effects: [
        {
          kind: "directory-create",
          path: target,
          mode: 0o755,
          removeOnTeardown: true,
        },
        // This will fail because "docker-container" is not yet implemented
        {
          kind: "docker-container",
          name: "c",
          image: "i",
          reuseIfRunning: false,
          keepOnTeardown: false,
          args: [],
          envVars: {},
          labels: {},
        },
      ],
      dockerArgs: [],
      envVars: {},
      outputOverrides: {},
    };

    // The plan should fail on the 2nd effect
    await assertRejects(
      () => executePlan(plan),
      Error,
      "Effect not yet implemented: docker-container",
    );

    // The directory created by the 1st effect should have been torn down
    await assertRejects(
      () => Deno.stat(target),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("executePlan: empty effects returns empty handles", async () => {
  const plan: StagePlan = {
    effects: [],
    dockerArgs: [],
    envVars: {},
    outputOverrides: {},
  };
  const handles = await executePlan(plan);
  assertEquals(handles.length, 0);
});

// ---------------------------------------------------------------------------
// file-write close() edge cases
// ---------------------------------------------------------------------------

Deno.test("executeEffect: file-write close() throws when file already deleted", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/will-be-deleted.txt`;
    const handle = await executeEffect({
      kind: "file-write",
      path: target,
      content: "temporary",
      mode: 0o644,
    });

    // Remove the file before close()
    await Deno.remove(target);

    // close() should throw because the file no longer exists
    await assertRejects(
      () => handle.close(),
      Deno.errors.NotFound,
    );
  });
});

// ---------------------------------------------------------------------------
// teardownHandles
// ---------------------------------------------------------------------------

Deno.test("teardownHandles: closes in reverse order", async () => {
  const order: number[] = [];
  const handles = [
    {
      kind: "a",
      close: async () => {
        order.push(1);
      },
    },
    {
      kind: "b",
      close: async () => {
        order.push(2);
      },
    },
    {
      kind: "c",
      close: async () => {
        order.push(3);
      },
    },
  ];

  await teardownHandles(handles);
  assertEquals(order, [3, 2, 1]);
});

Deno.test("teardownHandles: aggregates errors from multiple handles", async () => {
  const handles = [
    { kind: "ok", close: async () => {} },
    {
      kind: "fail-a",
      close: async () => {
        throw new Error("err-a");
      },
    },
    {
      kind: "fail-b",
      close: async () => {
        throw new Error("err-b");
      },
    },
  ];

  const err = await assertRejects(
    () => teardownHandles(handles),
    Error,
  );
  assertStringIncludes((err as Error).message, "2 handle(s)");
  assertStringIncludes((err as Error).message, "[fail-b]");
  assertStringIncludes((err as Error).message, "[fail-a]");
});

Deno.test("teardownHandles: continues closing remaining handles after error", async () => {
  const closed: string[] = [];
  const handles = [
    {
      kind: "first",
      close: async () => {
        closed.push("first");
      },
    },
    {
      kind: "middle",
      close: async () => {
        closed.push("middle");
        throw new Error("boom");
      },
    },
    {
      kind: "last",
      close: async () => {
        closed.push("last");
      },
    },
  ];

  await assertRejects(() => teardownHandles(handles), Error);
  // All three should have been attempted (in reverse order)
  assertEquals(closed, ["last", "middle", "first"]);
});

Deno.test("teardownHandles: empty handles is a no-op", async () => {
  await teardownHandles([]);
});
