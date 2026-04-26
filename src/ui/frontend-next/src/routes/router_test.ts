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
});
