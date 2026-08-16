import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOSTEXEC_CLIENT_CONTAINER_PATH,
  HOSTEXEC_GATEWAY_BINARY_NAME,
  INTERCEPT_LIB_CONTAINER_PATH,
  resolveHostExecClientPath,
  resolveHostExecGatewayPath,
  resolveInterceptLibPath,
} from "./intercept_path.ts";
import { hostExecInternalSocketPath } from "./registry.ts";

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

test("resolveHostExecClientPath: returns path when client exists", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-client-test-"));
  try {
    const clientDir = path.join(tmp, "hostexec");
    await mkdir(clientDir, { recursive: true });
    await writeFile(path.join(clientDir, "nas-hostexec-client"), "fake-client");

    const result = await resolveHostExecClientPath({ assetDir: tmp });
    expect(result).toEqual(path.join(tmp, "hostexec/nas-hostexec-client"));
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("resolveHostExecClientPath: returns null when client does not exist", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-client-test-"));
  try {
    const result = await resolveHostExecClientPath({ assetDir: tmp });
    expect(result).toEqual(null);
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("resolveHostExecGatewayPath: returns path when gateway exists", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-gateway-test-"));
  try {
    const gatewayDir = path.join(tmp, "hostexec");
    await mkdir(gatewayDir, { recursive: true });
    await writeFile(
      path.join(gatewayDir, HOSTEXEC_GATEWAY_BINARY_NAME),
      "fake-gateway",
    );

    const result = await resolveHostExecGatewayPath({ assetDir: tmp });
    expect(result).toEqual(path.join(tmp, "hostexec/nas-hostexec-gateway"));
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("resolveHostExecGatewayPath: returns null when gateway does not exist", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "nas-gateway-test-"));
  try {
    const result = await resolveHostExecGatewayPath({ assetDir: tmp });
    expect(result).toEqual(null);
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("HOSTEXEC_GATEWAY_BINARY_NAME has expected value", () => {
  expect(HOSTEXEC_GATEWAY_BINARY_NAME).toEqual("nas-hostexec-gateway");
});

test("HOSTEXEC_CLIENT_CONTAINER_PATH has expected value", () => {
  expect(HOSTEXEC_CLIENT_CONTAINER_PATH).toEqual(
    "/opt/nas/hostexec/libexec/nas-hostexec-client",
  );
});

test("hostExecInternalSocketPath: stays in the host-only broker directory", () => {
  const paths = {
    runtimeDir: "/run/user/1000/nas/hostexec",
    sessionsDir: "/run/user/1000/nas/hostexec/sessions",
    pendingDir: "/run/user/1000/nas/hostexec/pending",
    brokersDir: "/run/user/1000/nas/hostexec/brokers",
    wrappersDir: "/run/user/1000/nas/hostexec/wrappers",
  };
  expect(hostExecInternalSocketPath(paths, "session-1")).toBe(
    "/run/user/1000/nas/hostexec/brokers/session-1/gateway.sock",
  );
});
