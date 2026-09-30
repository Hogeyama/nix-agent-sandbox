import { expect, test } from "bun:test";
import { DEFAULT_FILESYSTEM, parseConfig } from "./config.ts";

test("empty config uses defaults", () => {
  expect(parseConfig("{}")).toEqual({
    githubRepos: [],
    filesystem: DEFAULT_FILESYSTEM,
    hostExec: false,
    statusLine: true,
    hosts: {},
  });
});

test("the status line can be left alone", () => {
  expect(parseConfig('{"statusLine": false}').statusLine).toBe(false);
});

test("hostExec is opt-in", () => {
  expect(parseConfig('{"hostExec": true}').hostExec).toBe(true);
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
  ["non-boolean hostExec", { hostExec: "yes" }],
  ["non-boolean statusLine", { statusLine: "no" }],
  ["wildcard host", { hosts: { "*.example.com": {} } }],
  ["host with a port", { hosts: { "devapi.example.com:8443": {} } }],
  ["uppercase host", { hosts: { "DevAPI.example.com": {} } }],
  ["single-label host", { hosts: { localhost: {} } }],
  ["IP address", { hosts: { "169.254.169.254": {} } }],
  ["a fixed host", { hosts: { "api.github.com": {} } }],
  ["the hostexec host", { hosts: { "hostexec.strait.invalid": {} } }],
  [
    "an Artifact content host",
    { hosts: { "abc.frame.claudeusercontent.com": {} } },
  ],
  ["unknown host key", { hosts: { "a.example.com": { paths: ["/"] } } }],
  [
    "strait's own token for another host",
    {
      hosts: {
        "a.example.com": {
          credential: { env: "GH_TOKEN", header: "x-api-key" },
        },
      },
    },
  ],
  [
    "one variable for two hosts",
    {
      hosts: {
        "a.example.com": { credential: { env: "K", header: "x-api-key" } },
        "b.example.com": { credential: { env: "K", header: "x-api-key" } },
      },
    },
  ],
  [
    "a credential in the cookie",
    {
      hosts: {
        "a.example.com": { credential: { env: "K", header: "cookie" } },
      },
    },
  ],
  [
    "an uppercase header",
    {
      hosts: {
        "a.example.com": { credential: { env: "K", header: "X-Api-Key" } },
      },
    },
  ],
  [
    "a scheme with a space",
    {
      hosts: {
        "a.example.com": {
          credential: { env: "K", header: "authorization", scheme: "Bearer x" },
        },
      },
    },
  ],
])("rejects %s", (_name, value) => {
  expect(() => parseConfig(JSON.stringify(value))).toThrow();
});

test("rejects non-object and invalid JSON", () => {
  expect(() => parseConfig("[]")).toThrow();
  expect(() => parseConfig("{")).toThrow();
});

test("hosts with and without a credential", () => {
  const c = parseConfig(
    JSON.stringify({
      hosts: {
        "devapi.example.com": {
          credential: { env: "DEVAPI_KEY", header: "x-api-key" },
        },
        "api.example.org": {
          credential: {
            env: "ORG_TOKEN",
            header: "authorization",
            scheme: "Bearer",
          },
        },
        "docs.example.com": {},
      },
    }),
  );
  expect(c.hosts).toEqual({
    "devapi.example.com": {
      credential: { env: "DEVAPI_KEY", header: "x-api-key" },
    },
    "api.example.org": {
      credential: {
        env: "ORG_TOKEN",
        header: "authorization",
        scheme: "Bearer",
      },
    },
    "docs.example.com": {},
  });
});
