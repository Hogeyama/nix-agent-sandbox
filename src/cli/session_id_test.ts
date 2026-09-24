import { expect, test } from "bun:test";
import { resolveSessionId } from "./session_id.ts";

const generate = () => "sess_generated";

test("resolveSessionId reuses the id handed over by the dtach re-exec", () => {
  expect(
    resolveSessionId(
      { NAS_INSIDE_DTACH: "1", NAS_SESSION_ID: "sess_parent" },
      generate,
    ),
  ).toBe("sess_parent");
});

test("resolveSessionId ignores an id inherited from an outer nas session", () => {
  expect(resolveSessionId({ NAS_SESSION_ID: "sess_parent" }, generate)).toBe(
    "sess_generated",
  );
});

test("resolveSessionId generates an id when the handed-over id is empty", () => {
  expect(
    resolveSessionId({ NAS_INSIDE_DTACH: "1", NAS_SESSION_ID: "" }, generate),
  ).toBe("sess_generated");
});
