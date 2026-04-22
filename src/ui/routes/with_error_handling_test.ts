import { expect, test } from "bun:test";
import {
  ContainerNotRunningError,
  NotNasManagedContainerError,
} from "../../domain/container.ts";
import { LaunchValidationError } from "../launch.ts";
import {
  mapErrorToResponse,
  withErrorHandling,
} from "./with_error_handling.ts";

test("withErrorHandling: passes through Response from handler", async () => {
  const original = new Response("ok", { status: 201 });
  const res = await withErrorHandling(() => original);
  expect(res).toBe(original);
  expect(res.status).toBe(201);
});

test("mapErrorToResponse: LaunchValidationError → 400", async () => {
  const res = mapErrorToResponse(new LaunchValidationError("invalid"));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid" });
});

test("mapErrorToResponse: ContainerNotRunningError → 409", async () => {
  const err = new ContainerNotRunningError("nas-x");
  const res = mapErrorToResponse(err);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: err.message });
});

test("mapErrorToResponse: NotNasManagedContainerError → 403", async () => {
  const err = new NotNasManagedContainerError("foo");
  const res = mapErrorToResponse(err);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: err.message });
});

test("mapErrorToResponse: Error starting with 'Session not found:' → 404", async () => {
  const res = mapErrorToResponse(new Error("Session not found: sess_x"));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Session not found: sess_x" });
});

test("mapErrorToResponse: 'Cannot acknowledge turn in state:' is NOT mapped (→ 500)", async () => {
  // The ack endpoint owns this 409 contract individually. Promoting it to
  // the global mapper would risk silent semantic regression if other
  // endpoints emit the same prefix. The ack endpoint catches this prefix
  // before re-throwing into withErrorHandling.
  const res = mapErrorToResponse(
    new Error("Cannot acknowledge turn in state: agent-turn"),
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: "Cannot acknowledge turn in state: agent-turn",
  });
});

test("mapErrorToResponse: generic Error → 500 with message", async () => {
  const res = mapErrorToResponse(new Error("boom"));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "boom" });
});

test("mapErrorToResponse: non-Error string → 500 with String(e)", async () => {
  const res = mapErrorToResponse("string error");
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "string error" });
});

test("mapErrorToResponse: null → 500 with String(null) = 'null'", async () => {
  const res = mapErrorToResponse(null);
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "null" });
});

test("withErrorHandling: thrown error is routed through mapper", async () => {
  const res = await withErrorHandling(() => {
    throw new LaunchValidationError("bad input");
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "bad input" });
});
