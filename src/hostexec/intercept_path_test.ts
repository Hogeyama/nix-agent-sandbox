import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INTERCEPT_LIB_CONTAINER_PATH,
  resolveInterceptLibPath,
} from "./intercept_path.ts";

test("resolveInterceptLibPath: returns path when .so exists", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-test-"));
  try {
    const soDir = path.join(tmp, "hostexec");
    await mkdir(soDir, { recursive: true });
    await writeFile(path.join(soDir, "hostexec_intercept.so"), "fake-so");

    const result = await resolveInterceptLibPath({ assetDir: tmp });
    expect(result).toEqual(path.join(tmp, "hostexec/hostexec_intercept.so"));
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("resolveInterceptLibPath: returns null when .so does not exist", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-intercept-test-"));
  try {
    const result = await resolveInterceptLibPath({ assetDir: tmp });
    expect(result).toEqual(null);
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("INTERCEPT_LIB_CONTAINER_PATH has expected value", () => {
  expect(INTERCEPT_LIB_CONTAINER_PATH).toEqual(
    "/opt/nas/hostexec/lib/hostexec_intercept.so",
  );
});
