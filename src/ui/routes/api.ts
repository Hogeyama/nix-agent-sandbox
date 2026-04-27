/**
 * REST API ルート
 */

import type { AuditDomain, AuditLogFilter } from "../../audit/types.ts";
import type { HostExecPromptScope } from "../../config/types.ts";
import { logInfo, logWarn } from "../../log.ts";
import type { ApprovalScope } from "../../network/protocol.ts";
import type { UiDataContext } from "../data.ts";
import {
  acknowledgeSessionTurn,
  approveHostExec,
  approveNetwork,
  cleanContainers,
  denyHostExec,
  denyNetwork,
  getAuditLogs,
  getHostExecPending,
  getNasContainers,
  getNetworkPending,
  getSessions,
  getTerminalSessions,
  killTerminalClients,
  renameSession,
  startShellSession,
  stopContainer,
} from "../data.ts";
import { getInfo } from "../info.ts";
import {
  getLaunchBranches,
  getLaunchInfo,
  type LaunchRequest,
  LaunchValidationError,
  launchSession,
} from "../launch.ts";
import { json, Router } from "../router.ts";
import { isSafeId } from "./validate_ids.ts";
import { withErrorHandling } from "./with_error_handling.ts";

const NETWORK_SCOPES: ReadonlySet<ApprovalScope> = new Set([
  "once",
  "host-port",
  "host",
]);
const HOSTEXEC_SCOPES: ReadonlySet<HostExecPromptScope> = new Set([
  "once",
  "capability",
]);

function validateNetworkScope(raw: unknown): ApprovalScope | undefined | Error {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return new Error("scope must be a string");
  if (!NETWORK_SCOPES.has(raw as ApprovalScope)) {
    return new Error(
      `Invalid scope: must be one of ${[...NETWORK_SCOPES].join(", ")}`,
    );
  }
  return raw as ApprovalScope;
}

function validateHostExecScope(
  raw: unknown,
): HostExecPromptScope | undefined | Error {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return new Error("scope must be a string");
  if (!HOSTEXEC_SCOPES.has(raw as HostExecPromptScope)) {
    return new Error(
      `Invalid scope: must be one of ${[...HOSTEXEC_SCOPES].join(", ")}`,
    );
  }
  return raw as HostExecPromptScope;
}

/**
 * Sanitize a session display name. Trims control characters (U+0000..U+001F,
 * U+007F) from anywhere in the string, caps the result at 200 characters,
 * and returns an Error if the name is empty after sanitization or exceeds
 * the cap *before* control-char stripping (to distinguish accidental giant
 * payloads from ordinary names).
 */
function sanitizeSessionName(raw: unknown): string | Error {
  if (typeof raw !== "string") return new Error("name must be a string");
  if (raw.length > 200) {
    return new Error("name must be 200 characters or fewer");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit strip
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  if (stripped.length === 0) {
    return new Error(
      "name must not be empty after removing control characters",
    );
  }
  return stripped;
}

export function createApiRoutes(ctx: UiDataContext): Router {
  const api = new Router();

  // --- Health ---

  api.get("/health", () => {
    return json({ ok: true });
  });

  // --- Info ---

  api.get("/info", () =>
    withErrorHandling(() => {
      const info = getInfo();
      return json(info);
    }),
  );

  // --- Launch ---

  api.get("/launch/info", ({ url }) =>
    withErrorHandling(async () => {
      const cwdParam = url.searchParams.get("cwd");
      const cwd = cwdParam && cwdParam !== "" ? cwdParam : undefined;
      const info = await getLaunchInfo(ctx, { cwd });
      return json(info);
    }),
  );

  api.get("/launch/branches", ({ url }) =>
    withErrorHandling(async () => {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        return json({ error: "cwd is required" }, 400);
      }
      const branches = await getLaunchBranches(cwd);
      return json(branches);
    }),
  );

  // 副作用 (logWarn / logInfo) を保持するためこの endpoint は手動
  // catch を維持する
  api.post("/launch", async ({ req }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const reqBody = body as LaunchRequest;
    logInfo(
      `[nas] /api/launch: profile=${reqBody?.profile} cwd=${reqBody?.cwd ?? "(unset)"} worktreeBase=${reqBody?.worktreeBase ?? "(unset)"} name=${reqBody?.name ?? "(unset)"}`,
    );
    try {
      const result = await launchSession(ctx, reqBody);
      logInfo(`[nas] /api/launch: started ${result.sessionId}`);
      return json(result);
    } catch (e) {
      if (e instanceof LaunchValidationError) {
        logWarn(`[nas] /api/launch: validation error: ${e.message}`);
        return json({ error: e.message }, 400);
      }
      logWarn(
        `[nas] /api/launch: failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return json({ error: (e as Error).message }, 500);
    }
  });

  // --- Network ---

  api.get("/network/pending", () =>
    withErrorHandling(async () => {
      const items = await getNetworkPending(ctx);
      return json({ items });
    }),
  );

  api.post("/network/approve", ({ req }) =>
    withErrorHandling(async () => {
      const body = await req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      if (!isSafeId(sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      if (!isSafeId(requestId)) {
        return json({ error: "Invalid requestId format" }, 400);
      }
      const validatedScope = validateNetworkScope(scope);
      if (validatedScope instanceof Error) {
        return json({ error: validatedScope.message }, 400);
      }
      await approveNetwork(ctx, sessionId, requestId, validatedScope);
      return json({ ok: true });
    }),
  );

  api.post("/network/deny", ({ req }) =>
    withErrorHandling(async () => {
      const body = await req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      if (!isSafeId(sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      if (!isSafeId(requestId)) {
        return json({ error: "Invalid requestId format" }, 400);
      }
      const validatedScope = validateNetworkScope(scope);
      if (validatedScope instanceof Error) {
        return json({ error: validatedScope.message }, 400);
      }
      await denyNetwork(ctx, sessionId, requestId, validatedScope);
      return json({ ok: true });
    }),
  );

  // --- HostExec ---

  api.get("/hostexec/pending", () =>
    withErrorHandling(async () => {
      const items = await getHostExecPending(ctx);
      return json({ items });
    }),
  );

  api.post("/hostexec/approve", ({ req }) =>
    withErrorHandling(async () => {
      const body = await req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      if (!isSafeId(sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      if (!isSafeId(requestId)) {
        return json({ error: "Invalid requestId format" }, 400);
      }
      const validatedScope = validateHostExecScope(scope);
      if (validatedScope instanceof Error) {
        return json({ error: validatedScope.message }, 400);
      }
      await approveHostExec(ctx, sessionId, requestId, validatedScope);
      return json({ ok: true });
    }),
  );

  api.post("/hostexec/deny", ({ req }) =>
    withErrorHandling(async () => {
      const body = await req.json();
      const { sessionId, requestId } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      if (!isSafeId(sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      if (!isSafeId(requestId)) {
        return json({ error: "Invalid requestId format" }, 400);
      }
      await denyHostExec(ctx, sessionId, requestId);
      return json({ ok: true });
    }),
  );

  // --- Sessions ---

  api.get("/sessions", () =>
    withErrorHandling(async () => {
      const sessions = await getSessions(ctx);
      return json(sessions);
    }),
  );

  api.patch("/sessions/:sessionId/name", ({ params, req }) =>
    withErrorHandling(async () => {
      if (!isSafeId(params.sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      const body = await req.json();
      const { name } = body;
      if (typeof name !== "string" || name.length === 0) {
        return json({ error: "name is required" }, 400);
      }
      const sanitized = sanitizeSessionName(name);
      if (sanitized instanceof Error) {
        return json({ error: sanitized.message }, 400);
      }
      const item = await renameSession(ctx, params.sessionId, sanitized);
      return json({ item });
    }),
  );

  api.post("/sessions/:sessionId/ack", ({ params }) =>
    withErrorHandling(async () => {
      if (!isSafeId(params.sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      try {
        const item = await acknowledgeSessionTurn(ctx, params.sessionId);
        return json({ item });
      } catch (e) {
        // "Cannot acknowledge turn in state:" prefix を mapper に入れない理由:
        // この 409 コントラクトは ack endpoint 固有であり、global mapper に
        // 昇格させると他 endpoint で同 prefix が偶発的に出た場合に silent な
        // semantic regression を引き起こすリスクがある。ここで個別 catch して
        // 409 化し、それ以外の error (Session not found: → 404、その他 → 500)
        // は外側 withErrorHandling の mapper に委譲する。
        if (
          e instanceof Error &&
          e.message.startsWith("Cannot acknowledge turn in state:")
        ) {
          return json({ error: e.message }, 409);
        }
        throw e;
      }
    }),
  );

  // --- Containers ---

  api.get("/containers", () =>
    withErrorHandling(async () => {
      const containers = await getNasContainers(ctx);
      return json({ items: containers });
    }),
  );

  api.post("/containers/:name/stop", ({ params }) =>
    withErrorHandling(async () => {
      if (!isSafeId(params.name)) {
        return json({ error: "Invalid container name format" }, 400);
      }
      await stopContainer(ctx, params.name);
      return json({ ok: true });
    }),
  );

  api.post("/containers/clean", ({ req }) =>
    withErrorHandling(async () => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(
          { error: "Missing or invalid JSON body: {confirm: true} required" },
          400,
        );
      }
      const confirm = (body as { confirm?: unknown } | null)?.confirm;
      if (confirm !== true) {
        return json(
          {
            error:
              'Confirmation required: POST {"confirm": true} to clean nas-managed containers',
          },
          400,
        );
      }
      const result = await cleanContainers(ctx);
      return json(result);
    }),
  );

  api.post("/containers/:name/shell", ({ params }) =>
    withErrorHandling(async () => {
      if (!isSafeId(params.name)) {
        return json({ error: "Invalid container name format" }, 400);
      }
      const result = await startShellSession(ctx, params.name);
      return json(result);
    }),
  );

  // --- Terminal (dtach sessions) ---

  api.get("/terminal/sessions", () =>
    withErrorHandling(async () => {
      const items = await getTerminalSessions(ctx);
      return json({ items });
    }),
  );

  api.post("/terminal/:sessionId/kill-clients", ({ params }) =>
    withErrorHandling(async () => {
      if (!isSafeId(params.sessionId)) {
        return json({ error: "Invalid sessionId format" }, 400);
      }
      const killed = await killTerminalClients(ctx, params.sessionId);
      return json({ killed });
    }),
  );

  // --- Audit ---

  api.get("/audit", ({ url }) =>
    withErrorHandling(async () => {
      const since = url.searchParams.get("since");
      const before = url.searchParams.get("before");
      const sessionsParam = url.searchParams.get("sessions");
      const sessionContains = url.searchParams.get("sessionContains");
      const domain = url.searchParams.get("domain");
      const limitStr = url.searchParams.get("limit");

      // Validate domain parameter
      if (domain && domain !== "network" && domain !== "hostexec") {
        return json(
          { error: 'Invalid domain: must be "network" or "hostexec"' },
          400,
        );
      }

      // Validate `before` is a parseable ISO timestamp
      if (before && Number.isNaN(Date.parse(before))) {
        return json(
          { error: "Invalid before: must be an ISO-8601 timestamp" },
          400,
        );
      }

      // Validate limit parameter
      let limit: number | undefined;
      if (limitStr) {
        limit = parseInt(limitStr, 10);
        if (Number.isNaN(limit) || limit < 1) {
          return json(
            { error: "Invalid limit: must be a positive integer" },
            400,
          );
        }
      }

      const filter: AuditLogFilter = {};
      if (since) filter.startDate = since;
      if (before) filter.before = before;
      if (sessionsParam !== null) {
        // Comma-separated set membership. An explicit empty value means
        // "no session IDs match" — return nothing rather than everything.
        filter.sessionIds = sessionsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      if (sessionContains) filter.sessionContains = sessionContains;
      if (domain) filter.domain = domain as AuditDomain;

      const items = await getAuditLogs(ctx, filter, limit);
      return json({ items });
    }),
  );

  return api;
}
