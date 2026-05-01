import { describe, expect, test } from "bun:test";
import { parseRoute } from "./router";

// `parseRoute` is pure and is the contract the rest of the router
// depends on. `createRouter` itself reads `window` and a Solid signal,
// so it lives outside this suite; exercising it would require a DOM
// shim plus a Solid root, neither of which adds coverage that the
// pure parse cases below do not already pin.
describe("parseRoute", () => {
  test("empty hash resolves to workspace", () => {
    expect(parseRoute("")).toEqual({ kind: "workspace" });
  });

  test("bare #/ resolves to workspace", () => {
    expect(parseRoute("#/")).toEqual({ kind: "workspace" });
  });

  test("#/settings/sidecars resolves to the sidecars page", () => {
    expect(parseRoute("#/settings/sidecars")).toEqual({
      kind: "settings",
      page: "sidecars",
    });
  });

  test("#/settings/audit resolves to the audit page", () => {
    expect(parseRoute("#/settings/audit")).toEqual({
      kind: "settings",
      page: "audit",
    });
  });

  test("#/settings/keybinds resolves to the keybinds page", () => {
    expect(parseRoute("#/settings/keybinds")).toEqual({
      kind: "settings",
      page: "keybinds",
    });
  });

  test("#/settings/prefs resolves to the prefs page", () => {
    expect(parseRoute("#/settings/prefs")).toEqual({
      kind: "settings",
      page: "prefs",
    });
  });

  test("#/settings without a page falls back to the default page", () => {
    expect(parseRoute("#/settings")).toEqual({
      kind: "settings",
      page: "sidecars",
    });
  });

  test("unknown settings page falls back to workspace", () => {
    expect(parseRoute("#/settings/unknown")).toEqual({ kind: "workspace" });
  });

  test("unrelated hash falls back to workspace", () => {
    expect(parseRoute("#/anything-else")).toEqual({ kind: "workspace" });
  });

  test("trailing extra segment under settings falls back to workspace", () => {
    expect(parseRoute("#/settings/audit/extra")).toEqual({ kind: "workspace" });
  });

  test("#/history resolves to the history list", () => {
    expect(parseRoute("#/history")).toEqual({ kind: "history" });
  });

  test("#/history/ (trailing slash) resolves to the history list", () => {
    expect(parseRoute("#/history/")).toEqual({ kind: "history" });
  });

  test("#/history/conversation/:id resolves with the id preserved", () => {
    expect(parseRoute("#/history/conversation/sess_abc123")).toEqual({
      kind: "history-conversation",
      id: "sess_abc123",
    });
  });

  test("#/history/invocation/:id resolves with the id preserved", () => {
    expect(parseRoute("#/history/invocation/inv_xyz_456")).toEqual({
      kind: "history-invocation",
      id: "inv_xyz_456",
    });
  });

  test("history detail with a missing id falls back to workspace", () => {
    expect(parseRoute("#/history/conversation/")).toEqual({
      kind: "workspace",
    });
    expect(parseRoute("#/history/conversation")).toEqual({ kind: "workspace" });
    expect(parseRoute("#/history/invocation/")).toEqual({ kind: "workspace" });
    expect(parseRoute("#/history/invocation")).toEqual({ kind: "workspace" });
  });

  test("history detail id containing '..' falls back to workspace", () => {
    expect(parseRoute("#/history/conversation/..etc")).toEqual({
      kind: "workspace",
    });
  });

  test("history detail id with disallowed characters falls back to workspace", () => {
    expect(parseRoute("#/history/conversation/abc/def")).toEqual({
      kind: "workspace",
    });
    expect(parseRoute("#/history/conversation/abc def")).toEqual({
      kind: "workspace",
    });
    expect(parseRoute("#/history/conversation/abc%2Fdef")).toEqual({
      kind: "workspace",
    });
  });

  test("history detail id starting with a dash or dot falls back to workspace", () => {
    expect(parseRoute("#/history/conversation/-abc")).toEqual({
      kind: "workspace",
    });
    expect(parseRoute("#/history/conversation/.abc")).toEqual({
      kind: "workspace",
    });
  });

  test("history detail id longer than 128 chars falls back to workspace", () => {
    const tooLong = "a".repeat(129);
    expect(parseRoute(`#/history/conversation/${tooLong}`)).toEqual({
      kind: "workspace",
    });
  });

  test("history with an unknown sub-page falls back to workspace", () => {
    expect(parseRoute("#/history/unknown/abc")).toEqual({ kind: "workspace" });
    expect(parseRoute("#/history/unknown")).toEqual({ kind: "workspace" });
  });

  test("history detail with an extra trailing segment falls back to workspace", () => {
    expect(parseRoute("#/history/conversation/abc/extra")).toEqual({
      kind: "workspace",
    });
  });
});
