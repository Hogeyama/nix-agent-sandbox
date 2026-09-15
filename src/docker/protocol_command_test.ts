import { expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  ProtocolCommandError,
  runProtocolCommand,
} from "./protocol_command.ts";

function sink() {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { output, text: () => Buffer.concat(chunks).toString() };
}

test("protocol bytes survive chunking and EOF without diagnostics", async () => {
  const { output, text } = sink();
  const input = Readable.from([
    Buffer.from('{"id":1,'),
    Buffer.from('"method":"initialize"}\n'),
  ]);
  await runProtocolCommand(
    "bash",
    ["-c", "cat; echo bootstrap-diagnostic >&2"],
    { input, output },
  );
  expect(text()).toBe('{"id":1,"method":"initialize"}\n');
});

test("nonzero payload status is preserved", async () => {
  const { output } = sink();
  try {
    await runProtocolCommand("bash", ["-c", "exit 23"], {
      input: new PassThrough(),
      output,
    });
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolCommandError);
    expect((error as ProtocolCommandError).exitCode).toBe(23);
  }
});

test("EOF terminates a payload that ignores EOF and TERM", async () => {
  const { output } = sink();
  await runProtocolCommand(
    "bash",
    ["-c", "trap '' TERM; while :; do :; done"],
    { input: Readable.from([]), output, graceMs: 40 },
  );
});

test("abort waits for child termination and detaches stream listeners", async () => {
  const { output } = sink();
  const input = new PassThrough();
  const controller = new AbortController();
  const running = runProtocolCommand("bash", ["-c", "while :; do :; done"], {
    input,
    output,
    signal: controller.signal,
    graceMs: 40,
  });
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  expect(input.listenerCount("end")).toBe(0);
  expect(output.listenerCount("close")).toBe(0);
});

test("closed protocol output terminates the payload", async () => {
  const { output } = sink();
  const running = runProtocolCommand("bash", ["-c", "while :; do :; done"], {
    input: new PassThrough(),
    output,
    graceMs: 40,
  });
  output.destroy();
  await expect(running).rejects.toThrow("disconnected");
});

for (const signal of ["TERM", "KILL"] as const) {
  test(`EOF does not hide payload SIG${signal} before transport termination`, async () => {
    const { output } = sink();
    await expect(
      runProtocolCommand("bash", ["-c", `cat >/dev/null; kill -${signal} $$`], {
        input: Readable.from([]),
        output,
      }),
    ).rejects.toThrow(`SIG${signal}`);
  });
}

test("EOF does not hide a different fatal signal triggered by TERM", async () => {
  const { output } = sink();
  await expect(
    runProtocolCommand(
      "bash",
      ["-c", "trap 'kill -KILL $$' TERM; cat >/dev/null; while :; do :; done"],
      {
        input: Readable.from([]),
        output,
        graceMs: 100,
      },
    ),
  ).rejects.toThrow("SIGKILL");
});

test("transport-issued EOF TERM is a normal shutdown", async () => {
  const { output } = sink();
  await runProtocolCommand(
    "bash",
    ["-c", "cat >/dev/null; while :; do :; done"],
    {
      input: Readable.from([]),
      output,
      graceMs: 40,
    },
  );
});

for (const exitCode of [0, 23]) {
  test(`payload exit ${exitCode} waits for the final asynchronous output write`, async () => {
    let flushed = false;
    const output = new Writable({
      write(_chunk, _encoding, done) {
        setTimeout(() => {
          flushed = true;
          done();
        }, 60);
      },
    });
    const running = runProtocolCommand(
      "bash",
      ["-c", `echo payload; exit ${exitCode}`],
      {
        input: new PassThrough(),
        output,
      },
    );
    if (exitCode === 0) await running;
    else await expect(running).rejects.toThrow("code 23");
    expect(flushed).toBe(true);
    expect(output.writableLength).toBe(0);
    expect(output.writableEnded).toBe(false);
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });
}

test("late asynchronous output failure rejects without an unhandled stream error", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      setTimeout(() => done(new Error("late EPIPE")), 60);
    },
  });
  await expect(
    runProtocolCommand("bash", ["-c", "echo payload"], {
      input: new PassThrough(),
      output,
    }),
  ).rejects.toThrow("late EPIPE");
  expect(output.listenerCount("error")).toBe(0);
  expect(output.listenerCount("close")).toBe(0);
});

test("cancellation settles a destination whose write callback is stalled", async () => {
  const controller = new AbortController();
  let lateCallback: ((error?: Error | null) => void) | undefined;
  const output = new Writable({
    write(_chunk, _encoding, done) {
      lateCallback = done;
      controller.abort();
    },
  });
  await expect(
    runProtocolCommand("bash", ["-c", "echo payload"], {
      input: new PassThrough(),
      output,
      signal: controller.signal,
    }),
  ).rejects.toThrow("interrupted");
  lateCallback?.(new Error("late error after cancellation"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(output.destroyed).toBe(true);
  expect(output.listenerCount("error")).toBe(0);
});
