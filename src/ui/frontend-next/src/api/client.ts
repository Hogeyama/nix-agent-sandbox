/**
 * REST client for the daemon HTTP surface consumed by the launch panel
 * and the terminals pane.
 *
 * Behaviour contract
 * ------------------
 *
 *   - `request<T>` always uses `globalThis.fetch`. Tests substitute the
 *     global at runtime so this module needs no DI plumbing.
 *
 *   - `Content-Type: application/json` is set only when a request body is
 *     supplied. GET requests therefore omit the header entirely so they
 *     do not trigger a CORS preflight in browsers and so the daemon does
 *     not see a misleading body declaration on bodyless calls.
 *
 *   - Non-2xx responses are turned into `HttpError` instances which carry
 *     the numeric `status` so call sites can branch on specific codes
 *     (e.g. silently absorb a 409 from `ackSessionTurn` while surfacing
 *     500). The client attempts to read `{error: string}` from the JSON
 *     body; if parsing fails or the field is missing, it falls back to
 *     `res.statusText`. The `.catch(() => ...)` on the body parse is an
 *     intentional fallback path: the wrapper *always* throws on the !ok
 *     branch, so the fallback never silently turns an HTTP failure into
 *     a success.
 *
 *   - 2xx responses always go through `res.json()` without a guard. If
 *     the daemon ever returns a 200 with a non-JSON body the parse will
 *     reject and the rejection propagates to the caller, which is the
 *     correct outcome — we never want a silent success that returns
 *     `undefined` when the wire contract is broken.
 *
 *   - User-controlled path components (`cwd`, `sessionId`, container
 *     name) are wrapped in `encodeURIComponent` at every call site so
 *     that values containing `/`, `?`, `&`, or whitespace cannot escape
 *     the intended endpoint.
 */

import type { SessionRecordLike } from "../stores/types";

/**
 * HTTP-level error that preserves the numeric response status.
 *
 * Call sites use `instanceof HttpError` + `.status` to differentiate
 * specific status codes (e.g. 409 from 500). `name = "HttpError"` makes
 * the class identifiable in `Error.toString()` and stack traces.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface LaunchInfo {
  dtachAvailable: boolean;
  profiles: string[];
  defaultProfile?: string;
  recentDirectories: string[];
}

export interface LaunchBranches {
  currentBranch: string | null;
  hasMain: boolean;
}

export interface LaunchRequest {
  profile: string;
  worktreeBase?: string;
  name?: string;
  cwd?: string;
}

export interface LaunchResult {
  sessionId: string;
}

export interface DtachSessionLike {
  name: string;
  sessionId: string;
  socketPath: string;
  createdAt: number;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await globalThis.fetch(path, {
    method,
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Intentional fallback: if the error body is not JSON or lacks a
    // string `error` field, fall back to the HTTP statusText. The
    // surrounding `if (!res.ok)` guarantees we throw either way.
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: unknown;
    };
    const message = typeof err.error === "string" ? err.error : res.statusText;
    throw new HttpError(res.status, message);
  }
  return (await res.json()) as T;
}

export function getLaunchInfo(): Promise<LaunchInfo> {
  return request<LaunchInfo>("GET", "/api/launch/info");
}

export function getLaunchBranches(cwd: string): Promise<LaunchBranches> {
  return request<LaunchBranches>(
    "GET",
    `/api/launch/branches?cwd=${encodeURIComponent(cwd)}`,
  );
}

export function launchSession(req: LaunchRequest): Promise<LaunchResult> {
  return request<LaunchResult>("POST", "/api/launch", req);
}

export async function getTerminalSessions(): Promise<DtachSessionLike[]> {
  const body = await request<{ items: DtachSessionLike[] }>(
    "GET",
    "/api/terminal/sessions",
  );
  return body.items;
}

export function killTerminalClients(sessionId: string): Promise<void> {
  return request<void>(
    "POST",
    `/api/terminal/${encodeURIComponent(sessionId)}/kill-clients`,
  );
}

/**
 * Acknowledge the agent turn for a session. The daemon responds with the
 * updated `SessionRecord` envelope on success, or 409 when the session is
 * not in a state that permits acknowledgement (callers branch on
 * `HttpError.status === 409` to absorb the benign race silently).
 */
export function ackSessionTurn(
  sessionId: string,
): Promise<{ item: SessionRecordLike }> {
  return request<{ item: SessionRecordLike }>(
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/ack`,
  );
}

/**
 * Rename a session. The backend strips control characters and caps the
 * length at 200; the returned `item.name` reflects the sanitized value
 * actually persisted, so the UI must surface that rather than echoing
 * the user-typed string.
 */
export function renameSession(
  sessionId: string,
  name: string,
): Promise<{ item: SessionRecordLike }> {
  return request<{ item: SessionRecordLike }>(
    "PATCH",
    `/api/sessions/${encodeURIComponent(sessionId)}/name`,
    { name },
  );
}

/**
 * Stop a running container by Docker name. The backend returns
 * `{ok: true}` on success; the explicit return type prevents callers
 * from silently discarding a `void` and missing future shape changes.
 */
export function stopContainer(containerName: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    "POST",
    `/api/containers/${encodeURIComponent(containerName)}/stop`,
  );
}

/**
 * Start an interactive shell in the named container. The backend
 * provisions a dtach socket and returns its session id, which the UI
 * uses to attach the terminals pane.
 */
export function startShell(
  containerName: string,
): Promise<{ dtachSessionId: string }> {
  return request<{ dtachSessionId: string }>(
    "POST",
    `/api/containers/${encodeURIComponent(containerName)}/shell`,
  );
}
