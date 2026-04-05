import { assertEquals } from "@std/assert";
import { isWSL, resolveNotifyBackend } from "./notify_utils.ts";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = Deno.env.get(key);
  }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

Deno.test("isWSL: returns true when WSL_DISTRO_NAME is set", () => {
  withEnv({ WSL_DISTRO_NAME: "Ubuntu" }, () => {
    assertEquals(isWSL(), true);
  });
});

Deno.test("isWSL: returns false when WSL_DISTRO_NAME is unset", () => {
  withEnv({ WSL_DISTRO_NAME: undefined }, () => {
    assertEquals(isWSL(), false);
  });
});

Deno.test("resolveNotifyBackend: off stays off", () => {
  assertEquals(resolveNotifyBackend("off"), "off");
});

Deno.test("resolveNotifyBackend: desktop stays desktop", () => {
  assertEquals(resolveNotifyBackend("desktop"), "desktop");
});

Deno.test("resolveNotifyBackend: auto resolves to desktop", () => {
  assertEquals(resolveNotifyBackend("auto"), "desktop");
});
