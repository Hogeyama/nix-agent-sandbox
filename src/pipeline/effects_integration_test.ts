import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { executeEffect, executePlan, teardownHandles } from "./effects.ts";
import type { ResourceEffect, StagePlan } from "./types.ts";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helper: create a unique temp directory for test isolation
// ---------------------------------------------------------------------------

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "effects_test_"));
  try {
    await fn(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// directory-create
// ---------------------------------------------------------------------------

test("executeEffect: directory-create creates directory", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/sub/nested`;
    const handle = await executeEffect({
      kind: "directory-create",
      path: target,
      mode: 0o755,
      removeOnTeardown: false,
    });

    expect(handle.kind).toEqual("directory-create");
    const st = await stat(target);
    expect(st.isDirectory()).toEqual(true);

    // close should be a no-op since removeOnTeardown=false
    await handle.close();
    const statAfter = await stat(target);
    expect(statAfter.isDirectory()).toEqual(true);
  });
});

test("executeEffect: directory-create removeOnTeardown removes directory", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/removable`;
    const handle = await executeEffect({
      kind: "directory-create",
      path: target,
      mode: 0o755,
      removeOnTeardown: true,
    });

    const st = await stat(target);
    expect(st.isDirectory()).toEqual(true);

    await handle.close();

    await expect(stat(target)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// file-write
// ---------------------------------------------------------------------------

test("executeEffect: file-write creates file with content and mode", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/test.txt`;
    const handle = await executeEffect({
      kind: "file-write",
      path: target,
      content: "hello world",
      mode: 0o644,
    });

    expect(handle.kind).toEqual("file-write");
    const content = await readFile(target, "utf8");
    expect(content).toEqual("hello world");

    const st = await stat(target);
    // Check that file mode matches (mask with 0o777 to ignore file type bits)
    expect(st.mode !== null && (st.mode & 0o777) === 0o644).toEqual(true);

    // teardown removes the file
    await handle.close();
    await expect(stat(target)).rejects.toThrow();
  });
});

test("executeEffect: file-write with executable mode", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/script.sh`;
    const handle = await executeEffect({
      kind: "file-write",
      path: target,
      content: "#!/bin/sh\necho hi",
      mode: 0o755,
    });

    const st = await stat(target);
    expect(st.mode !== null && (st.mode & 0o777) === 0o755).toEqual(true);

    await handle.close();
  });
});

// ---------------------------------------------------------------------------
// Unimplemented effects
// ---------------------------------------------------------------------------

test("executeEffect: unimplemented effects throw", async () => {
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
    await expect(executeEffect(effect)).rejects.toThrow(
      `Effect not yet implemented: ${effect.kind}`,
    );
  }

  // unix-listener with session-broker spec throws a different message
  await expect(
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
  ).rejects.toThrow("unix-listener session-broker not yet implemented");
});

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

test("executePlan: executes effects in order and returns handles", async () => {
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
    expect(handles.length).toEqual(2);
    expect(handles[0].kind).toEqual("directory-create");
    expect(handles[1].kind).toEqual("file-write");

    // Verify side effects occurred
    const content = await readFile(`${dir}/plandir/file.txt`, "utf8");
    expect(content).toEqual("plan content");

    // Clean up via teardown
    await teardownHandles(handles);
  });
});

test("executePlan: tears down prior handles when Nth effect fails", async () => {
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
    await expect(executePlan(plan)).rejects.toThrow(
      "Effect not yet implemented: docker-container",
    );

    // The directory created by the 1st effect should have been torn down
    await expect(stat(target)).rejects.toThrow();
  });
});

test("executePlan: empty effects returns empty handles", async () => {
  const plan: StagePlan = {
    effects: [],
    dockerArgs: [],
    envVars: {},
    outputOverrides: {},
  };
  const handles = await executePlan(plan);
  expect(handles.length).toEqual(0);
});

// ---------------------------------------------------------------------------
// file-write close() edge cases
// ---------------------------------------------------------------------------

test("executeEffect: file-write close() throws when file already deleted", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/will-be-deleted.txt`;
    const handle = await executeEffect({
      kind: "file-write",
      path: target,
      content: "temporary",
      mode: 0o644,
    });

    // Remove the file before close()
    await rm(target, { force: true });

    // close() should throw because the file no longer exists
    await expect(handle.close()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// teardownHandles
// ---------------------------------------------------------------------------

test("teardownHandles: closes in reverse order", async () => {
  const order: number[] = [];
  const handles = [
    {
      kind: "a",
      // deno-lint-ignore require-await
      close: async () => {
        order.push(1);
      },
    },
    {
      kind: "b",
      // deno-lint-ignore require-await
      close: async () => {
        order.push(2);
      },
    },
    {
      kind: "c",
      // deno-lint-ignore require-await
      close: async () => {
        order.push(3);
      },
    },
  ];

  await teardownHandles(handles);
  expect(order).toEqual([3, 2, 1]);
});

test("teardownHandles: aggregates errors from multiple handles", async () => {
  const handles = [
    { kind: "ok", close: async () => {} },
    {
      kind: "fail-a",
      // deno-lint-ignore require-await
      close: async () => {
        throw new Error("err-a");
      },
    },
    {
      kind: "fail-b",
      // deno-lint-ignore require-await
      close: async () => {
        throw new Error("err-b");
      },
    },
  ];

  let err: Error | undefined;
  try {
    await teardownHandles(handles);
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();
  expect(err!.message).toContain("2 handle(s)");
  expect(err!.message).toContain("[fail-b]");
  expect(err!.message).toContain("[fail-a]");
});

test("teardownHandles: continues closing remaining handles after error", async () => {
  const closed: string[] = [];
  const handles = [
    {
      kind: "first",
      // deno-lint-ignore require-await
      close: async () => {
        closed.push("first");
      },
    },
    {
      kind: "middle",
      // deno-lint-ignore require-await
      close: async () => {
        closed.push("middle");
        throw new Error("boom");
      },
    },
    {
      kind: "last",
      // deno-lint-ignore require-await
      close: async () => {
        closed.push("last");
      },
    },
  ];

  await expect(teardownHandles(handles)).rejects.toThrow();
  // All three should have been attempted (in reverse order)
  expect(closed).toEqual(["last", "middle", "first"]);
});

test("teardownHandles: empty handles is a no-op", async () => {
  await teardownHandles([]);
});
