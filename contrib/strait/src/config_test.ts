import { expect, test } from "bun:test";
import { DEFAULT_FILESYSTEM, parseConfig } from "./config.ts";

test("empty config uses defaults", () => {
  expect(parseConfig("{}")).toEqual({
    githubRepos: [],
    filesystem: DEFAULT_FILESYSTEM,
  });
});

test("filesystem keys override one by one", () => {
  const c = parseConfig(
    JSON.stringify({
      githubRepos: ["my-org/private-repo"],
      filesystem: { denyWrite: [".claude", ".local/state"] },
    }),
  );
  expect(c.githubRepos).toEqual(["my-org/private-repo"]);
  expect(c.filesystem.denyWrite).toEqual([".claude", ".local/state"]);
  expect(c.filesystem.allowRead).toEqual(DEFAULT_FILESYSTEM.allowRead);
});

test.each([
  [
    "network section",
    { network: { tlsTerminate: { excludeDomains: ["api.github.com"] } } },
  ],
  ["unknown filesystem key", { filesystem: { allowAllUnixSockets: true } }],
  ["repo without owner", { githubRepos: ["private-repo"] }],
  ["repo with path", { githubRepos: ["my-org/private-repo/issues"] }],
  ["repo with percent", { githubRepos: ["my%2Dorg/repo"] }],
  ["non-string path", { filesystem: { denyRead: [1] } }],
])("rejects %s", (_name, value) => {
  expect(() => parseConfig(JSON.stringify(value))).toThrow();
});

test("rejects non-object and invalid JSON", () => {
  expect(() => parseConfig("[]")).toThrow();
  expect(() => parseConfig("{")).toThrow();
});
