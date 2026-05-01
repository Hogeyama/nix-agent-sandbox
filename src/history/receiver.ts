/**
 * OTLP/HTTP receiver — Bun.serve listener bound to 127.0.0.1 that accepts
 * OTLP/JSON `ExportTraceServiceRequest` payloads on `POST /v1/traces` and
 * forwards them to `ingestResourceSpans`.
 *
 * Lifecycle is owned by the caller: `startOtlpReceiver` returns a handle
 * exposing the chosen port and an idempotent `close()`. The receiver is bound
 * to loopback only — the host filesystem-bound forward-port relay is the
 * intended exposure path into containers.
 *
 * Protocol contract: only `application/json` (with optional parameters) is
 * accepted. `application/x-protobuf` is rejected with 415; the OTEL SDK in
 * the agent container is configured to use http/json explicitly.
 */

import type { Database } from "bun:sqlite";
import { ingestResourceSpans, type OtlpJsonExportPayload } from "./ingest.ts";

export interface OtlpReceiverHandle {
  /** Actual port the OS chose for the 127.0.0.1 listener. */
  readonly port: number;
  /** Stop the server, draining in-flight requests. Idempotent. */
  close(): Promise<void>;
}

export interface StartOtlpReceiverOptions {
  /** Writer-mode history db handle. The receiver writes only; reads are not its concern. */
  db: Database;
  /** Optional override for testing / future per-session lifecycle. Default `0` (OS-chosen ephemeral). */
  port?: number;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * `application/json` with optional parameters (e.g. `; charset=utf-8`).
 * OTLP/HTTP spec only mandates `application/json` for the JSON encoding,
 * but tolerating the charset suffix avoids spurious rejections from clients
 * that always emit it.
 */
function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const semi = value.indexOf(";");
  const base = (semi === -1 ? value : value.slice(0, semi))
    .trim()
    .toLowerCase();
  return base === "application/json";
}

async function handleTraces(req: Request, db: Database): Promise<Response> {
  if (!isJsonContentType(req.headers.get("content-type"))) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  let payload: OtlpJsonExportPayload;
  try {
    payload = (await req.json()) as OtlpJsonExportPayload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    ingestResourceSpans(db, payload);
  } catch (e) {
    // Log + 500 but do NOT propagate: a single malformed batch should not
    // tear down the listener nor trigger SDK retries that would amplify
    // the failure.
    console.warn(
      `otlp receiver: ingest failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return new Response("Internal Server Error", { status: 500 });
  }

  // Empty `partialSuccess` per OTLP/HTTP spec: server accepted the entire
  // batch. We don't surface per-span ingest drops to the client because the
  // SDK has no useful retry strategy for them.
  return new Response(JSON.stringify({ partialSuccess: {} }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

async function handle(req: Request, db: Database): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/v1/traces") {
    return new Response("Not Found", { status: 404 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  return await handleTraces(req, db);
}

export async function startOtlpReceiver(
  opts: StartOtlpReceiverOptions,
): Promise<OtlpReceiverHandle> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch: (req) =>
      handle(req, opts.db).catch((e) => {
        // Defensive net: handle() already swallows ingest errors, but if any
        // other unexpected throw escapes (e.g. from URL parsing) we still
        // owe the client a response rather than letting Bun.serve emit a
        // generic 500 that drops the connection.
        console.warn(
          `otlp receiver: handler crashed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return new Response("Internal Server Error", { status: 500 });
      }),
  });

  // Bun's `Server.port` is typed `number | undefined` (e.g. when listening on
  // a UDS); we always bind to a TCP port so this should be defined, but
  // narrow defensively rather than non-null asserting.
  if (typeof server.port !== "number") {
    await server.stop(true);
    throw new Error("startOtlpReceiver: Bun.serve did not assign a TCP port");
  }
  const port = server.port;

  let closed = false;
  return {
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      // closeActiveConnections: true so in-flight requests are cut off
      // immediately. Callers wanting a graceful drain must quiesce upstream
      // exporters before invoking close(); the handle itself drops in-flight
      // requests as soon as close() is invoked.
      await server.stop(true);
    },
  };
}
