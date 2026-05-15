/**
 * OTLP/HTTP receiver — Bun.serve listener bound to 127.0.0.1 that accepts
 * OTLP/JSON `ExportTraceServiceRequest` payloads on `POST /v1/traces` and
 * `ExportLogsServiceRequest` payloads on `POST /v1/logs`, forwarding them to
 * `ingestResourceSpans` and `ingestLogRecords` respectively.
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
import {
  ingestResourceSpans,
  type OtlpJsonExportPayload,
  type OtlpJsonResourceSpans,
} from "./ingest.ts";
import {
  ingestLogRecords,
  type OtlpJsonExportLogsPayload,
} from "./ingest_logs.ts";
import type { OtlpKeyValue } from "./otlp_wire.ts";

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
  /**
   * Per-session metadata used when an exporter does not emit nas resource
   * attributes. Existing resource attributes win; fallback values never
   * overwrite payload-provided metadata.
   */
  fallbackMetadata?: OtlpReceiverFallbackMetadata;
}

export interface OtlpReceiverFallbackMetadata {
  readonly sessionId: string;
  readonly profileName?: string;
  readonly agent?: string;
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

function stringAttr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function hasAttr(
  attrs: ReadonlyArray<OtlpKeyValue> | undefined,
  key: string,
): boolean {
  return Array.isArray(attrs) && attrs.some((attr) => attr?.key === key);
}

function applyFallbackMetadata(
  payload: OtlpJsonExportPayload,
  fallback: OtlpReceiverFallbackMetadata | undefined,
): OtlpJsonExportPayload {
  if (fallback === undefined) return payload;
  const resourceSpans = payload.resourceSpans;
  if (!Array.isArray(resourceSpans)) return payload;

  return {
    ...payload,
    resourceSpans: resourceSpans.map((rs): OtlpJsonResourceSpans => {
      const attrs = rs.resource?.attributes ?? [];
      const patchedAttrs = [...attrs];
      if (!hasAttr(attrs, "nas.session.id")) {
        patchedAttrs.push(stringAttr("nas.session.id", fallback.sessionId));
      }
      if (
        fallback.profileName !== undefined &&
        !hasAttr(attrs, "nas.profile")
      ) {
        patchedAttrs.push(stringAttr("nas.profile", fallback.profileName));
      }
      if (fallback.agent !== undefined && !hasAttr(attrs, "nas.agent")) {
        patchedAttrs.push(stringAttr("nas.agent", fallback.agent));
      }
      return {
        ...rs,
        resource: {
          ...rs.resource,
          attributes: patchedAttrs,
        },
      };
    }),
  };
}

async function handleTraces(
  req: Request,
  db: Database,
  fallbackMetadata: OtlpReceiverFallbackMetadata | undefined,
): Promise<Response> {
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
    ingestResourceSpans(db, applyFallbackMetadata(payload, fallbackMetadata));
  } catch {
    // Return 500 but do NOT propagate: a single malformed batch should not
    // tear down the listener nor trigger SDK retries that would amplify
    // the failure. No log output — the agent terminal shares this process's
    // stdout/stderr while the session is live.
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

async function handleLogs(
  req: Request,
  db: Database,
  sessionId: string,
): Promise<Response> {
  if (!isJsonContentType(req.headers.get("content-type"))) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  let payload: OtlpJsonExportLogsPayload;
  try {
    payload = (await req.json()) as OtlpJsonExportLogsPayload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    ingestLogRecords(db, payload, sessionId);
  } catch {
    // Return 500 but do NOT propagate: same reasoning as handleTraces.
    return new Response("Internal Server Error", { status: 500 });
  }

  // Empty `partialSuccess` per OTLP/HTTP spec: server accepted the entire
  // batch. We don't surface per-record ingest drops to the client because the
  // SDK has no useful retry strategy for them.
  return new Response(JSON.stringify({ partialSuccess: {} }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

async function handle(
  req: Request,
  db: Database,
  fallbackMetadata: OtlpReceiverFallbackMetadata | undefined,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/v1/traces") {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    return await handleTraces(req, db, fallbackMetadata);
  }
  if (url.pathname === "/v1/logs") {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    // `startOtlpReceiver` is always called with `fallbackMetadata.sessionId`
    // set; the empty-string fallback never fires in practice. The
    // `log_records` schema does not include agent/profile columns, so only
    // `invocationId` (sessionId) is needed to satisfy the FK to `invocations`.
    const sessionId = fallbackMetadata?.sessionId ?? "";
    return await handleLogs(req, db, sessionId);
  }
  return new Response("Not Found", { status: 404 });
}

export async function startOtlpReceiver(
  opts: StartOtlpReceiverOptions,
): Promise<OtlpReceiverHandle> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch: (req) =>
      handle(req, opts.db, opts.fallbackMetadata).catch(() => {
        // Defensive net: handle() already swallows ingest errors, but if
        // an unexpected throw escapes (e.g. from URL parsing) we still owe
        // the client a response rather than letting Bun.serve drop the
        // connection. No log output: stdout/stderr stays clean while the
        // agent session owns this process.
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
