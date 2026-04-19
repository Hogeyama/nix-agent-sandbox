/**
 * Pure helper tests for notify_utils. The Bun.spawn-dependent paths (desktop
 * notification + CLI action notification) are covered by integration tests
 * that run under X or WSL; here we pin down just the logic a unit test can
 * exercise deterministically.
 */

import { expect, test } from "bun:test";
import {
  isWSL,
  resolveNasCommand,
  resolveNotifyBackend,
} from "./notify_utils.ts";

test("resolveNotifyBackend: 'off' stays off", () => {
  expect(resolveNotifyBackend("off")).toEqual("off");
});

test("resolveNotifyBackend: 'desktop' returns desktop", () => {
  expect(resolveNotifyBackend("desktop")).toEqual("desktop");
});

test("resolveNotifyBackend: 'auto' always resolves to 'desktop'", () => {
  // Comment on the function says: "'auto' always resolves to 'desktop'".
  // tryDesktopNotification() handles graceful fallback if notify-send is missing.
  expect(resolveNotifyBackend("auto")).toEqual("desktop");
});

test("isWSL: reflects WSL_DISTRO_NAME presence", () => {
  const original = process.env.WSL_DISTRO_NAME;
  try {
    delete process.env.WSL_DISTRO_NAME;
    expect(isWSL()).toEqual(false);

    process.env.WSL_DISTRO_NAME = "Ubuntu-22.04";
    expect(isWSL()).toEqual(true);

    process.env.WSL_DISTRO_NAME = "";
    expect(isWSL()).toEqual(false);
  } finally {
    if (original === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = original;
    }
  }
});

test("resolveNasCommand: returns the current bun exec path and run prefix when uncompiled", () => {
  const { execPath, prefix } = resolveNasCommand();
  // Under bun test the execPath ends with "bun" (or "bun-linux-...") and
  // prefix is ["run", "<abs>/main.ts"].
  expect(execPath).toEqual(process.execPath);
  // When running under the bun CLI (not a compiled binary) the prefix carries
  // the entry script path.
  if (prefix.length > 0) {
    expect(prefix[0]).toEqual("run");
    expect(prefix[1].endsWith("/main.ts")).toEqual(true);
  }
});
