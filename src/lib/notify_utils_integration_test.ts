import { expect, test } from "bun:test";
import { isWSL, resolveNotifyBackend } from "./notify_utils.ts";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("isWSL: returns true when WSL_DISTRO_NAME is set", () => {
  withEnv({ WSL_DISTRO_NAME: "Ubuntu" }, () => {
    expect(isWSL()).toEqual(true);
  });
});

test("isWSL: returns false when WSL_DISTRO_NAME is unset", () => {
  withEnv({ WSL_DISTRO_NAME: undefined }, () => {
    expect(isWSL()).toEqual(false);
  });
});

test("resolveNotifyBackend: off stays off", () => {
  expect(resolveNotifyBackend("off")).toEqual("off");
});

test("resolveNotifyBackend: desktop stays desktop", () => {
  expect(resolveNotifyBackend("desktop")).toEqual("desktop");
});

test("resolveNotifyBackend: auto resolves to desktop", () => {
  expect(resolveNotifyBackend("auto")).toEqual("desktop");
});
