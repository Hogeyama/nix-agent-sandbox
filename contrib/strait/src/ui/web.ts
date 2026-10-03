// strait review web: a browser inbox for the requests every session holds.
//
// The server listens on an ephemeral loopback port, which any local process
// or web page can reach, so being reachable grants nothing. Authority is a
// random capability that only the host terminal sees: it is written to
// /dev/tty, never to stdout or stderr, which could be redirected somewhere
// the sandbox reads. Every API call must carry it in an Authorization header
// and come from the exact Origin, which a cross-site page can do neither of.
//
// The browser can list what is waiting and decide one request by its REF,
// nothing else: no socket command passes through, and nothing can be held
// or changed in policy from here. Approval semantics stay in core/approval.ts.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { HOLD_MS } from "../core/approval.ts";
import { INHERITED_ENV } from "../core/hostexec.ts";
import { collect, decideRef, type Held, parseRef } from "./review.ts";

const MAX_BODY = 4096;
const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/** What the browser gets for one held request; nothing else crosses. */
export interface InboxRecord {
  ref: string;
  session: string;
  cwd: string;
  command: string[];
  method: string;
  url: string;
  reason: string;
  body?: string;
  exec?: { argv: string[]; cwd: string; env: Record<string, string> };
  since: number;
  expiresAt: number;
}

export interface ReviewBackend {
  list(): Promise<InboxRecord[]>;
  decide(ref: string, approve: boolean): Promise<boolean>;
}

export interface Assets {
  html: string;
  js: string;
  css: string;
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Copy the fields the inbox shows, by name. A session answering with more,
 * or with a field of the wrong type, gets that request left out rather than
 * shown partly: a hostexec request without its command must never look like
 * a plain HTTP one.
 */
export function inboxRecord(h: Held): InboxRecord | null {
  const e = h.exec as unknown;
  if (
    typeof h.ref !== "string" ||
    typeof h.method !== "string" ||
    typeof h.url !== "string" ||
    typeof h.reason !== "string" ||
    (h.body !== undefined && typeof h.body !== "string") ||
    !Number.isSafeInteger(h.since) ||
    (h.expiresAt !== undefined && !Number.isSafeInteger(h.expiresAt)) ||
    typeof h.session?.id !== "string" ||
    typeof h.session.cwd !== "string" ||
    !strings(h.session.command)
  ) {
    return null;
  }
  // The browser refuses the whole list over one bad record, so a session
  // from an older strait, whose refs have no incarnation, is left out here.
  const expiresAt = h.expiresAt ?? h.since + HOLD_MS;
  if (parseRef(h.ref)?.session !== h.session.id || expiresAt <= h.since) {
    return null;
  }
  let exec: InboxRecord["exec"];
  if (e !== undefined) {
    if (typeof e !== "object" || e === null) return null;
    const { argv, cwd, env } = e as Record<string, unknown>;
    if (
      !strings(argv) ||
      argv.length === 0 ||
      typeof cwd !== "string" ||
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env) ||
      !Object.values(env).every((v) => typeof v === "string")
    ) {
      return null;
    }
    exec = {
      argv: [...argv],
      cwd,
      env: { ...(env as Record<string, string>) },
    };
  }
  return {
    ref: h.ref,
    session: h.session.id,
    cwd: h.session.cwd,
    command: [...h.session.command],
    method: h.method,
    url: h.url,
    reason: h.reason,
    ...(exec ? { exec } : h.body !== undefined ? { body: h.body } : {}),
    since: h.since,
    // A strait from before expiresAt still denies at HOLD_MS.
    expiresAt,
  };
}

function response(body: string, status = 200, type = "application/json") {
  return new Response(body, {
    status,
    headers: { ...HEADERS, "Content-Type": `${type}; charset=utf-8` },
  });
}

function hasCapability(header: string | null, token: string): boolean {
  if (header === null || !/^Bearer [0-9a-f]{64}$/.test(header)) return false;
  return timingSafeEqual(
    Buffer.from(header.slice("Bearer ".length)),
    Buffer.from(token),
  );
}

async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type") !== "application/json") throw new Error();
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
    throw new Error();
  if (req.body === null) throw new Error();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel();
        throw new Error();
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
  );
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new Error();
  return data as Record<string, unknown>;
}

export function webHandler(options: {
  authority: () => string;
  token: string;
  backend: ReviewBackend;
  assets: Assets;
}): (req: Request) => Promise<Response> {
  const { authority, token, backend, assets } = options;
  if (!/^[0-9a-f]{64}$/.test(token))
    throw new Error("invalid startup capability");
  return async (req) => {
    const host = authority();
    const origin = `http://${host}`;
    const url = new URL(req.url);
    // An exact Host defeats DNS rebinding: a rebound name arrives with its
    // own Host header.
    if (
      req.headers.get("host") !== host ||
      url.origin !== origin ||
      url.search !== ""
    ) {
      return response('{"error":"forbidden"}', 403);
    }
    if (req.method === "GET") {
      const asset = {
        "/": [assets.html, "text/html"],
        "/app.js": [assets.js, "text/javascript"],
        "/style.css": [assets.css, "text/css"],
      }[url.pathname];
      return asset
        ? response(asset[0], 200, asset[1])
        : response('{"error":"not found"}', 404);
    }
    // Every API call, listing included, is a POST so that the browser sends
    // Origin. Authorization is not a CORS-safelisted header, and no CORS
    // headers are ever sent, so no other origin can make the call.
    if (
      req.method !== "POST" ||
      req.headers.get("origin") !== origin ||
      !hasCapability(req.headers.get("authorization"), token) ||
      (req.headers.has("sec-fetch-site") &&
        req.headers.get("sec-fetch-site") !== "same-origin")
    ) {
      return response('{"error":"forbidden"}', 403);
    }
    if (url.pathname !== "/api/pending" && url.pathname !== "/api/decision") {
      return response('{"error":"not found"}', 404);
    }
    let body: Record<string, unknown>;
    try {
      body = await jsonObject(req);
    } catch {
      return response('{"error":"bad request"}', 400);
    }
    try {
      if (url.pathname === "/api/pending") {
        if (Object.keys(body).length !== 0)
          return response('{"error":"bad request"}', 400);
        return response(
          JSON.stringify({
            pending: await backend.list(),
            inheritedEnv: INHERITED_ENV,
          }),
        );
      }
      const { ref, approve } = body;
      if (
        Object.keys(body).length !== 2 ||
        typeof ref !== "string" ||
        parseRef(ref) === null ||
        typeof approve !== "boolean"
      ) {
        return response('{"error":"bad request"}', 400);
      }
      return (await backend.decide(ref, approve))
        ? response('{"ok":true}')
        : response('{"error":"request no longer pending"}', 409);
    } catch {
      // No error text: it could carry request data or the capability.
      return response('{"error":"review unavailable"}', 503);
    }
  };
}

export function startWebReview(dir: string) {
  const token = randomBytes(32).toString("hex");
  const asset = (name: string) =>
    readFileSync(join(import.meta.dir, "web-ui", name), "utf8");
  const handler = webHandler({
    authority: () => `127.0.0.1:${server.port}`,
    token,
    backend: {
      list: async () =>
        (await collect(dir, { all: true }))
          .map(inboxRecord)
          .filter((r) => r !== null),
      decide: (ref, approve) => decideRef(dir, ref, approve),
    },
    assets: {
      html: asset("index.html"),
      js: asset("app.js"),
      css: asset("style.css"),
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_BODY,
    idleTimeout: 10,
    fetch: handler,
    error: () => response('{"error":"bad request"}', 400),
  });
  return { server, url: `http://127.0.0.1:${server.port}/#${token}` };
}

/** Serve until Ctrl-C. Without a controlling terminal, refuse to start. */
export async function launchWebReview(dir: string): Promise<number> {
  let tty: number;
  try {
    tty = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  } catch {
    console.error(
      "strait review web: needs a terminal on the host to print its link to",
    );
    return 2;
  }
  let running: ReturnType<typeof startWebReview> | undefined;
  try {
    running = startWebReview(dir);
    writeSync(
      tty,
      `strait review web: open this private link in a browser on the host\n${running.url}\nCtrl-C stops the inbox; held requests stay held.\n`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  } finally {
    closeSync(tty);
    running?.server.stop(true);
  }
}
