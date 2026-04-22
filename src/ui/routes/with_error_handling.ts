/**
 * Route error-handling helper — consolidates error → HTTP status mapping
 * for REST API route handlers.
 */

import {
  ContainerNotRunningError,
  NotNasManagedContainerError,
} from "../../domain/container.ts";
import { LaunchValidationError } from "../launch.ts";
import { json } from "../router.ts";

/**
 * Map an error to an HTTP Response with appropriate status code.
 *
 * Mapping:
 * - LaunchValidationError → 400
 * - ContainerNotRunningError → 409
 * - NotNasManagedContainerError → 403
 * - Error message starts with "Session not found:" → 404
 * - default → 500
 *
 * Note: the "Cannot acknowledge turn in state:" prefix is intentionally NOT
 * mapped here. That 409 contract is specific to the ack endpoint, and
 * promoting it to a global mapper would risk silent semantic regression
 * if other endpoints emit the same prefix. The ack endpoint should catch
 * this prefix individually and convert to 409 before re-throwing.
 *
 * Body shape is uniformly `{ error: string }` across all paths. Non-Error
 * throws are normalized via `String(e)` so `null`/`undefined`/object
 * payloads still produce a structured response.
 */
export function mapErrorToResponse(e: unknown): Response {
  if (e instanceof LaunchValidationError) {
    return json({ error: e.message }, 400);
  }
  if (e instanceof ContainerNotRunningError) {
    return json({ error: e.message }, 409);
  }
  if (e instanceof NotNasManagedContainerError) {
    return json({ error: e.message }, 403);
  }
  if (e instanceof Error && e.message.startsWith("Session not found:")) {
    return json({ error: e.message }, 404);
  }
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

/**
 * Wrap a route handler with consolidated error → HTTP status mapping.
 *
 * The handler returns `Response | Promise<Response>`; uncaught errors are
 * routed through {@link mapErrorToResponse}.
 */
export async function withErrorHandling(
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    return await handler();
  } catch (e) {
    return mapErrorToResponse(e);
  }
}
