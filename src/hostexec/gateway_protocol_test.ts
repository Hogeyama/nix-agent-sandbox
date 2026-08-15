import { expect, test } from "bun:test";
import {
  maxControlBytes,
  parseBrokerToGateway,
  parseBrokerToGatewayLine,
  parseExternalExecute,
  parseExternalExecuteLine,
  parseGatewayToBroker,
  parseGatewayToBrokerLine,
} from "./gateway_protocol.ts";

const externalRequest = {
  version: 2 as const,
  type: "execute" as const,
  sessionId: "session-1",
  requestId: "request-1",
  argv0: "/bin/cat",
  args: [],
  cwd: "/work",
  tty: false,
  stdinMode: "fd" as const,
};

const encodeBytes = (length: number): string =>
  Buffer.alloc(length, 0x78).toString("base64");

const sizedTransportErrorPayload = (byteLength: number): string => {
  const prefix = '{"type":"transport_error","requestId":"r","message":"';
  const suffix = '"}';
  const messageLength =
    byteLength -
    new TextEncoder().encode(prefix).byteLength -
    new TextEncoder().encode(suffix).byteLength;
  if (messageLength < 0) throw new Error("payload size is too small");
  return `${prefix}${"x".repeat(messageLength)}${suffix}`;
};

test("external execute accepts v2 metadata and stdinMode", () => {
  expect(parseExternalExecute(externalRequest)).toEqual(externalRequest);
});

test("external execute requires protocol version 2 and stdinMode", () => {
  expect(() =>
    parseExternalExecute({
      version: 1,
      type: "execute",
      sessionId: "s",
      requestId: "r",
      argv0: "cat",
      args: [],
      cwd: "/work",
      tty: false,
      stdinMode: "fd",
    }),
  ).toThrow(/version/i);

  const { stdinMode: _stdinMode, ...withoutStdinMode } = externalRequest;
  expect(() => parseExternalExecute(withoutStdinMode)).toThrow(/stdinMode/i);
});

test("gateway-to-broker accepts every message variant in its legal state", () => {
  expect(
    parseGatewayToBroker(
      { type: "execute", request: externalRequest },
      "awaiting_decision",
    ).type,
  ).toBe("execute");
  expect(
    parseGatewayToBroker(
      { type: "spawned", requestId: "r", pid: 42 },
      "running",
    ).type,
  ).toBe("spawned");
  expect(
    parseGatewayToBroker(
      { type: "raw_chunk", requestId: "r", fd: 1, data: "eA==" },
      "running",
    ).type,
  ).toBe("raw_chunk");
  expect(
    parseGatewayToBroker(
      { type: "process_exit", requestId: "r", exitCode: 0 },
      "running",
    ).type,
  ).toBe("process_exit");
  expect(
    parseGatewayToBroker(
      { type: "cancelled", requestId: "r", reason: "client disconnected" },
      "running",
    ).type,
  ).toBe("cancelled");
  expect(
    parseGatewayToBroker(
      { type: "transport_error", requestId: "r", message: "closed" },
      "running",
    ).type,
  ).toBe("transport_error");
});

test("broker-to-gateway accepts every message variant in its legal state", () => {
  expect(
    parseBrokerToGateway(
      { type: "fallback", requestId: "r" },
      "awaiting_decision",
    ).type,
  ).toBe("fallback");
  expect(
    parseBrokerToGateway(
      { type: "error", requestId: "r", message: "denied" },
      "awaiting_decision",
    ).type,
  ).toBe("error");
  expect(
    parseBrokerToGateway(
      {
        type: "start",
        requestId: "r",
        argv0: "cat",
        args: [],
        cwd: "/work",
        env: {},
      },
      "awaiting_decision",
    ).type,
  ).toBe("start");
  expect(
    parseBrokerToGateway(
      { type: "masked_chunk", requestId: "r", fd: 2, data: "eA==" },
      "running",
    ).type,
  ).toBe("masked_chunk");
  expect(
    parseBrokerToGateway(
      { type: "result", requestId: "r", exitCode: 0 },
      "awaiting_result",
    ).type,
  ).toBe("result");
  expect(
    parseBrokerToGateway(
      { type: "kill", requestId: "r", signal: "SIGTERM" },
      "running",
    ).type,
  ).toBe("kill");
});

test("chunk parsers preserve valid base64 and enforce the decoded 64 KiB limit", () => {
  const chunk = {
    type: "raw_chunk" as const,
    requestId: "r",
    fd: 1 as const,
    data: "eA==",
  };
  expect(parseGatewayToBroker(chunk, "running")).toEqual(chunk);

  expect(() =>
    parseGatewayToBroker(
      { ...chunk, data: encodeBytes(64 * 1024 + 1) },
      "running",
    ),
  ).toThrow(/64|chunk|payload/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "masked_chunk", requestId: "r", fd: 1, data: "not base64!" },
      "running",
    ),
  ).toThrow(/base64/i);
});

test("chunk parsers require canonical standard base64 padding bits", () => {
  expect(
    parseGatewayToBroker(
      { type: "raw_chunk", requestId: "r", fd: 1, data: "AA==" },
      "running",
    ),
  ).toMatchObject({ data: "AA==" });
  expect(
    parseBrokerToGateway(
      { type: "masked_chunk", requestId: "r", fd: 2, data: "AAA=" },
      "running",
    ),
  ).toMatchObject({ data: "AAA=" });
  expect(() =>
    parseGatewayToBroker(
      { type: "raw_chunk", requestId: "r", fd: 1, data: "AB==" },
      "running",
    ),
  ).toThrow(/base64/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "masked_chunk", requestId: "r", fd: 2, data: "AB==" },
      "running",
    ),
  ).toThrow(/base64/i);
});

test("numeric process fields must be integers", () => {
  expect(() =>
    parseGatewayToBroker(
      { type: "spawned", requestId: "r", pid: 1.5 },
      "running",
    ),
  ).toThrow(/int/i);
  expect(() =>
    parseGatewayToBroker(
      { type: "process_exit", requestId: "r", exitCode: 1.5 },
      "running",
    ),
  ).toThrow(/int/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "result", requestId: "r", exitCode: 1.5 },
      "awaiting_result",
    ),
  ).toThrow(/int/i);
});

test("PID and exit code use the same signed 32-bit domain", () => {
  const min = -2_147_483_648;
  const max = 2_147_483_647;
  expect(
    parseGatewayToBroker(
      { type: "spawned", requestId: "r", pid: min },
      "running",
    ),
  ).toMatchObject({ pid: min });
  expect(
    parseGatewayToBroker(
      { type: "spawned", requestId: "r", pid: max },
      "running",
    ),
  ).toMatchObject({ pid: max });
  expect(
    parseBrokerToGateway(
      { type: "result", requestId: "r", exitCode: min },
      "awaiting_result",
    ),
  ).toMatchObject({ exitCode: min });
  expect(
    parseBrokerToGateway(
      { type: "result", requestId: "r", exitCode: max },
      "awaiting_result",
    ),
  ).toMatchObject({ exitCode: max });
  expect(() =>
    parseGatewayToBroker(
      { type: "spawned", requestId: "r", pid: max + 1 },
      "running",
    ),
  ).toThrow(/32|range|too large|number/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "result", requestId: "r", exitCode: min - 1 },
      "awaiting_result",
    ),
  ).toThrow(/32|range|too large|number/i);
});

test("secret-bearing start rejects unknown keys", () => {
  expect(() =>
    parseBrokerToGateway(
      {
        type: "start",
        requestId: "r",
        argv0: "cat",
        args: [],
        cwd: "/work",
        env: { TOKEN: "secret" },
        extra: "must reject",
      },
      "awaiting_decision",
    ),
  ).toThrow(/unrecognized|unknown|extra/i);
});

test("raw_chunk is gateway-to-broker only after start", () => {
  expect(() =>
    parseGatewayToBroker(
      { type: "raw_chunk", requestId: "r", fd: 1, data: "eA==" },
      "awaiting_decision",
    ),
  ).toThrow(/state/i);
});

test("fallback is only legal before start and masked chunks are broker-to-gateway", () => {
  expect(() =>
    parseBrokerToGateway({ type: "fallback", requestId: "r" }, "running"),
  ).toThrow(/state/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "error", requestId: "r", message: "failed" },
      "running",
    ),
  ).toThrow(/state/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "kill", requestId: "r", signal: "SIGTERM" },
      "awaiting_result",
    ),
  ).toThrow(/state/i);
  expect(() =>
    parseGatewayToBroker(
      { type: "masked_chunk", requestId: "r", fd: 1, data: "eA==" },
      "running",
    ),
  ).toThrow(/direction|type|gateway/i);
});

test("strict schemas reject missing fields and unknown message types", () => {
  expect(() =>
    parseGatewayToBroker({ type: "spawned", requestId: "r" }, "running"),
  ).toThrow(/pid/i);
  expect(() =>
    parseBrokerToGateway(
      { type: "start", requestId: "r", argv0: "cat", args: [], cwd: "/work" },
      "awaiting_decision",
    ),
  ).toThrow(/env/i);
  expect(() =>
    parseGatewayToBroker({ type: "unknown", requestId: "r" }, "running"),
  ).toThrow(/type/i);
});

test("control messages over 4 MiB are rejected", () => {
  expect(() =>
    parseGatewayToBroker(
      {
        type: "transport_error",
        requestId: "r",
        message: "x".repeat(4 * 1024 * 1024),
      },
      "running",
    ),
  ).toThrow(/4|control|large|size/i);
});

test("raw NDJSON lines enforce the physical UTF-8 limit before JSON parsing", () => {
  const validLine = JSON.stringify({
    type: "spawned",
    requestId: "r",
    pid: 42,
  });
  const validBytes = new TextEncoder().encode(validLine).byteLength;
  const oversizedLine = `${" ".repeat(maxControlBytes - validBytes + 1)}${validLine}`;

  expect(() => parseGatewayToBrokerLine(oversizedLine, "running")).toThrow(
    /4|control|size/i,
  );
  expect(() =>
    parseExternalExecuteLine(`${" ".repeat(maxControlBytes)}${validLine}`),
  ).toThrow(/4|control|size/i);
  expect(() =>
    parseBrokerToGatewayLine(
      new TextEncoder().encode(oversizedLine),
      "running",
    ),
  ).toThrow(/4|control|size/i);
});

test("raw NDJSON framing excludes exactly one LF or CRLF delimiter", () => {
  const payload = sizedTransportErrorPayload(maxControlBytes);

  expect(parseGatewayToBrokerLine(`${payload}\n`, "running")).toMatchObject({
    type: "transport_error",
    requestId: "r",
  });
  expect(parseGatewayToBrokerLine(`${payload}\r\n`, "running")).toMatchObject({
    type: "transport_error",
    requestId: "r",
  });
  expect(() => parseGatewayToBrokerLine(`${payload} \n`, "running")).toThrow(
    /4|control|size/i,
  );
});
