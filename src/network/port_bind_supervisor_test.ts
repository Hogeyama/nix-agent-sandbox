import { expect, test } from "bun:test";
import { makeRelaySupervisor } from "./port_bind_supervisor.ts";

function harness(
  overrides: Partial<Parameters<typeof makeRelaySupervisor>[0]> = {},
) {
  let now = 0;
  const calls: string[][] = [];
  let connected = false;
  const overrideExec = overrides.exec;
  const supervisor = makeRelaySupervisor({
    command: ["bun", "/usr/local/lib/nas/port-relay.mjs"],
    isRelayConnected: () => connected,
    waitForControl: async () => connected,
    now: () => now,
    sleep: async () => {},
    ...overrides,
    exec: async (cmd) => {
      calls.push(cmd);
      if (overrideExec) return overrideExec(cmd);
      connected = true;
      return { code: 0, stderr: "" };
    },
  });
  return {
    supervisor,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

test("ensure execs once and reports ready", async () => {
  const h = harness();
  expect(await h.supervisor.ensure()).toEqual("ready");
  expect(h.calls).toHaveLength(1);
});

test("ensure does not exec again while the relay is connected", async () => {
  const h = harness();
  await h.supervisor.ensure();
  await h.supervisor.ensure();
  expect(h.calls).toHaveLength(1);
});

test("an existing control connection resets earlier startup failures", async () => {
  const h = harness({
    exec: async () => ({ code: 1, stderr: "docker daemon unreachable" }),
  });
  for (let i = 0; i < 2; i += 1) {
    h.advance(3000);
    await h.supervisor.ensure();
  }

  h.setConnected(true);
  expect(await h.supervisor.ensure()).toEqual("ready");
  h.setConnected(false);

  for (let i = 0; i < 2; i += 1) {
    h.advance(3000);
    expect(await h.supervisor.ensure()).toEqual("unreachable");
  }
  expect(h.calls).toHaveLength(4);
});

test("a control connection arriving during exec is ready without another wait", async () => {
  let connected = false;
  const supervisor = makeRelaySupervisor({
    exec: async () => {
      connected = true;
      return { code: 0, stderr: "" };
    },
    command: ["bun", "/usr/local/lib/nas/port-relay.mjs"],
    isRelayConnected: () => connected,
    waitForControl: async () => false,
  });

  expect(await supervisor.ensure()).toEqual("ready");
});

test("a relay that connected and then died is re-exec'd without counting a failure", async () => {
  const h = harness();
  await h.supervisor.ensure();
  h.setConnected(false);
  h.advance(5000);
  expect(await h.supervisor.ensure()).toEqual("ready");
  expect(h.calls).toHaveLength(2);
});

test("a stopped container is reported and never counted as a failure", async () => {
  const h = harness({
    exec: async () => ({
      code: 1,
      stderr: "Error: No such container: nas-agent-x",
    }),
    waitForControl: async () => false,
  });
  for (let i = 0; i < 5; i += 1) {
    h.advance(3000);
    expect(await h.supervisor.ensure()).toEqual("container-not-running");
  }
  expect(h.calls).toHaveLength(5);
});

test("three failures start a cool-off that a later attempt clears", async () => {
  const h = harness({
    exec: async () => ({ code: 1, stderr: "docker daemon unreachable" }),
    waitForControl: async () => false,
  });
  for (let i = 0; i < 3; i += 1) {
    h.advance(3000);
    expect(await h.supervisor.ensure()).toEqual("unreachable");
  }
  const callsBeforeCoolOff = h.calls.length;
  h.advance(3000);
  expect(await h.supervisor.ensure()).toEqual("unreachable");
  expect(h.calls).toHaveLength(callsBeforeCoolOff);
  h.advance(61_000);
  expect(await h.supervisor.ensure()).toEqual("unreachable");
  expect(h.calls).toHaveLength(callsBeforeCoolOff + 1);
});

test("concurrent callers share one exec", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    exec: async () => {
      await gate;
      return { code: 0, stderr: "" };
    },
  });
  const both = Promise.all([h.supervisor.ensure(), h.supervisor.ensure()]);
  release();
  await both;
  expect(h.calls).toHaveLength(1);
});
