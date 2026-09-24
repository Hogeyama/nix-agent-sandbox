import { expect, test } from "bun:test";
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
} from "./credentials.ts";

test("resolveAgentCredentials: Claude defaults to proxy", () => {
  expect(resolveAgentCredentials("claude", undefined)).toBe("proxy");
});

test("resolveAgentCredentials: other agents default to shared", () => {
  expect(resolveAgentCredentials("codex", undefined)).toBe("shared");
  expect(resolveAgentCredentials("copilot", undefined)).toBe("shared");
});

test("resolveAgentCredentials: an explicit value wins over the default", () => {
  expect(resolveAgentCredentials("claude", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "proxy")).toBe("proxy");
});

test("supportsProxiedCredentials: only Claude is implemented", () => {
  expect(supportsProxiedCredentials("claude")).toBe(true);
  expect(supportsProxiedCredentials("codex")).toBe(false);
  expect(supportsProxiedCredentials("copilot")).toBe(false);
});
