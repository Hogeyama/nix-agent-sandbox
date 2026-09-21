import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateDockerConfig } from "./test_docker_config_fixture.ts";

test("Docker test config keeps daemon context but excludes registry credentials and helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "nas-docker-config-test-"));
  try {
    const source = join(root, "user");
    const target = join(root, "test");
    mkdirSync(join(source, "contexts", "meta", "fixture"), { recursive: true });
    const config = {
      currentContext: "fixture",
      credsStore: "pass",
      credHelpers: { "registry.example": "pass" },
      auths: { "registry.example": { auth: "test-only-secret" } },
      proxies: { default: { httpProxy: "http://user:secret@proxy" } },
    };
    writeFileSync(join(source, "config.json"), JSON.stringify(config));
    writeFileSync(
      join(source, "contexts", "meta", "fixture", "meta.json"),
      '{"Name":"fixture"}',
    );
    isolateDockerConfig(source, target);
    expect(
      JSON.parse(readFileSync(join(target, "config.json"), "utf8")),
    ).toEqual({ currentContext: "fixture" });
    expect(
      existsSync(join(target, "contexts", "meta", "fixture", "meta.json")),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(source, "config.json"), "utf8")),
    ).toEqual(config);
    isolateDockerConfig(join(root, "missing"), join(root, "empty"));
    expect(
      JSON.parse(readFileSync(join(root, "empty", "config.json"), "utf8")),
    ).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
