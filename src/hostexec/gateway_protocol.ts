import { z } from "zod";

export const maxControlBytes = 4 * 1024 * 1024;
export const maxChunkBytes = 64 * 1024;

export type GatewayState =
  | "awaiting_decision"
  | "running"
  | "awaiting_result"
  | "terminal";

const gatewayStateSchema = z.enum([
  "awaiting_decision",
  "running",
  "awaiting_result",
  "terminal",
]);

/** The external request sent by a container-side client. */
export const externalExecuteSchema = z
  .object({
    version: z.literal(2),
    type: z.literal("execute"),
    sessionId: z.string(),
    requestId: z.string(),
    argv0: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    tty: z.boolean(),
    stdinMode: z.enum(["fd", "none"]),
  })
  .strict();

export type ExternalExecuteRequestV2 = z.infer<typeof externalExecuteSchema>;

function isStrictStandardBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1 && firstPadding < value.length - 2) {
    // A single '=' may occur only at the final position, and '==' only at
    // the final two positions. The regexp above handles the alphabet; this
    // check makes the padding position explicit for runtimes whose base64
    // decoder is permissive.
    const padding = value.slice(firstPadding);
    if (padding !== "=" && padding !== "==") return false;
  }
  return true;
}

function decodedChunk(value: string): Buffer {
  if (!isStrictStandardBase64(value)) {
    throw new Error("chunk data must be standard base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("chunk data must use canonical standard base64");
  }
  return decoded;
}

const chunkDataSchema = z.string().superRefine((value, context) => {
  try {
    if (decodedChunk(value).byteLength > maxChunkBytes) {
      context.addIssue({
        code: "custom",
        message: `decoded chunk exceeds ${maxChunkBytes} bytes`,
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid base64 chunk",
    });
  }
});

const streamFdSchema = z.union([z.literal(1), z.literal(2)]);
const requestIdSchema = z.string();
const processIntegerSchema = z
  .number()
  .int()
  .min(-2_147_483_648)
  .max(2_147_483_647);

const gatewayExecuteSchema = z
  .object({
    type: z.literal("execute"),
    request: externalExecuteSchema,
  })
  .strict();

const spawnedSchema = z
  .object({
    type: z.literal("spawned"),
    requestId: requestIdSchema,
    pid: processIntegerSchema,
  })
  .strict();

const rawChunkSchema = z
  .object({
    type: z.literal("raw_chunk"),
    requestId: requestIdSchema,
    fd: streamFdSchema,
    data: chunkDataSchema,
  })
  .strict();

const processExitSchema = z
  .object({
    type: z.literal("process_exit"),
    requestId: requestIdSchema,
    exitCode: processIntegerSchema,
  })
  .strict();

const cancelledSchema = z
  .object({
    type: z.literal("cancelled"),
    requestId: requestIdSchema,
    reason: z.string(),
  })
  .strict();

const transportErrorSchema = z
  .object({
    type: z.literal("transport_error"),
    requestId: requestIdSchema,
    message: z.string(),
  })
  .strict();

export const gatewayToBrokerSchema = z.discriminatedUnion("type", [
  gatewayExecuteSchema,
  spawnedSchema,
  rawChunkSchema,
  processExitSchema,
  cancelledSchema,
  transportErrorSchema,
]);

export type GatewayToBrokerMessage = z.infer<typeof gatewayToBrokerSchema>;

const fallbackSchema = z
  .object({
    type: z.literal("fallback"),
    requestId: requestIdSchema,
  })
  .strict();

const errorSchema = z
  .object({
    type: z.literal("error"),
    requestId: requestIdSchema,
    message: z.string(),
  })
  .strict();

const startSchema = z
  .object({
    type: z.literal("start"),
    requestId: requestIdSchema,
    argv0: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
  })
  .strict();

const maskedChunkSchema = z
  .object({
    type: z.literal("masked_chunk"),
    requestId: requestIdSchema,
    fd: streamFdSchema,
    data: chunkDataSchema,
  })
  .strict();

const resultSchema = z
  .object({
    type: z.literal("result"),
    requestId: requestIdSchema,
    exitCode: processIntegerSchema,
  })
  .strict();

const killSchema = z
  .object({
    type: z.literal("kill"),
    requestId: requestIdSchema,
    signal: z.enum(["SIGTERM", "SIGKILL"]),
  })
  .strict();

export const brokerToGatewaySchema = z.discriminatedUnion("type", [
  fallbackSchema,
  errorSchema,
  startSchema,
  maskedChunkSchema,
  resultSchema,
  killSchema,
]);

export type BrokerToGatewayMessage = z.infer<typeof brokerToGatewaySchema>;

export type GatewayWireLine = string | Uint8Array;

function parseWireLine(line: GatewayWireLine): unknown {
  const bytes =
    typeof line === "string" ? new TextEncoder().encode(line) : line;
  let payloadEnd = bytes.byteLength;
  if (payloadEnd > 0 && bytes[payloadEnd - 1] === 0x0a) {
    payloadEnd -= 1;
    if (payloadEnd > 0 && bytes[payloadEnd - 1] === 0x0d) {
      payloadEnd -= 1;
    }
  }
  const payloadBytes = bytes.subarray(0, payloadEnd);
  if (payloadBytes.byteLength > maxControlBytes) {
    throw new Error(`control message exceeds ${maxControlBytes} bytes`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    throw new Error("control message is not valid UTF-8");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("control message is not valid JSON");
  }
}

function assertControlSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("control message is not JSON serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > maxControlBytes) {
    throw new Error(`control message exceeds ${maxControlBytes} bytes`);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw result.error;
  assertControlSize(result.data);
  return result.data;
}

const statesForGatewayType: Readonly<
  Record<GatewayToBrokerMessage["type"], readonly GatewayState[]>
> = {
  execute: ["awaiting_decision"],
  spawned: ["running"],
  raw_chunk: ["running"],
  process_exit: ["running"],
  cancelled: ["awaiting_decision", "running", "awaiting_result"],
  transport_error: ["awaiting_decision", "running", "awaiting_result"],
};

const statesForBrokerType: Readonly<
  Record<BrokerToGatewayMessage["type"], readonly GatewayState[]>
> = {
  fallback: ["awaiting_decision"],
  error: ["awaiting_decision", "awaiting_result"],
  start: ["awaiting_decision"],
  masked_chunk: ["running", "awaiting_result"],
  result: ["awaiting_result"],
  kill: ["running"],
};

function assertState(state: GatewayState): void {
  if (!gatewayStateSchema.safeParse(state).success) {
    throw new Error(`invalid gateway state: ${String(state)}`);
  }
}

function assertLegalState(
  direction: "gateway-to-broker" | "broker-to-gateway",
  type: GatewayToBrokerMessage["type"] | BrokerToGatewayMessage["type"],
  state: GatewayState,
): void {
  assertState(state);
  const allowed =
    direction === "gateway-to-broker"
      ? statesForGatewayType[type as GatewayToBrokerMessage["type"]]
      : statesForBrokerType[type as BrokerToGatewayMessage["type"]];
  if (!allowed?.includes(state)) {
    throw new Error(
      `${direction} message ${type} is not legal in gateway state ${state}`,
    );
  }
}

export function parseExternalExecute(value: unknown): ExternalExecuteRequestV2 {
  return parseOrThrow(externalExecuteSchema, value);
}

export function parseExternalExecuteLine(
  line: GatewayWireLine,
): ExternalExecuteRequestV2 {
  return parseExternalExecute(parseWireLine(line));
}

export function parseGatewayToBroker(
  value: unknown,
  state: GatewayState,
): GatewayToBrokerMessage {
  const parsed = parseOrThrow(gatewayToBrokerSchema, value);
  assertLegalState("gateway-to-broker", parsed.type, state);
  return parsed;
}

export function parseGatewayToBrokerLine(
  line: GatewayWireLine,
  state: GatewayState,
): GatewayToBrokerMessage {
  return parseGatewayToBroker(parseWireLine(line), state);
}

export function parseBrokerToGateway(
  value: unknown,
  state: GatewayState,
): BrokerToGatewayMessage {
  const parsed = parseOrThrow(brokerToGatewaySchema, value);
  assertLegalState("broker-to-gateway", parsed.type, state);
  return parsed;
}

export function parseBrokerToGatewayLine(
  line: GatewayWireLine,
  state: GatewayState,
): BrokerToGatewayMessage {
  return parseBrokerToGateway(parseWireLine(line), state);
}
