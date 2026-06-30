import { expect, test } from "bun:test";
import { findMatchingCredentials } from "./credential_matching.ts";
import type { ResolvedCredential } from "./protocol.ts";

const creds: ResolvedCredential[] = [
  { host: "github.com", header: "Authorization", value: "token ghp_abc" },
  {
    host: "api.github.com",
    pathPrefix: "/repos/myorg/",
    header: "Authorization",
    value: "token ghp_abc",
  },
  { host: "*.npmjs.org", header: "Authorization", value: "Bearer npm_xyz" },
  {
    host: "api.example.com",
    method: "POST",
    header: "X-API-Key",
    value: "key123",
  },
];

test("findMatchingCredentials: matches by host", () => {
  const result = findMatchingCredentials(creds, "github.com", 443, "GET", "/");
  expect(result).toEqual([{ name: "Authorization", value: "token ghp_abc" }]);
});

test("findMatchingCredentials: matches by host + pathPrefix", () => {
  const result = findMatchingCredentials(
    creds,
    "api.github.com",
    443,
    "GET",
    "/repos/myorg/nas",
  );
  expect(result).toEqual([{ name: "Authorization", value: "token ghp_abc" }]);
});

test("findMatchingCredentials: pathPrefix mismatch returns empty", () => {
  const result = findMatchingCredentials(
    creds,
    "api.github.com",
    443,
    "GET",
    "/repos/other/nas",
  );
  expect(result).toEqual([]);
});

test("findMatchingCredentials: wildcard host matches subdomain", () => {
  const result = findMatchingCredentials(
    creds,
    "registry.npmjs.org",
    443,
    "GET",
    "/",
  );
  expect(result).toEqual([{ name: "Authorization", value: "Bearer npm_xyz" }]);
});

test("findMatchingCredentials: method filter applies", () => {
  const post = findMatchingCredentials(
    creds,
    "api.example.com",
    443,
    "POST",
    "/data",
  );
  expect(post).toEqual([{ name: "X-API-Key", value: "key123" }]);

  const get = findMatchingCredentials(
    creds,
    "api.example.com",
    443,
    "GET",
    "/data",
  );
  expect(get).toEqual([]);
});

test("findMatchingCredentials: all-match returns multiple headers", () => {
  const multiCreds: ResolvedCredential[] = [
    { host: "api.example.com", header: "Authorization", value: "Bearer tok" },
    { host: "api.example.com", header: "X-API-Key", value: "key123" },
  ];
  const result = findMatchingCredentials(
    multiCreds,
    "api.example.com",
    443,
    "GET",
    "/",
  );
  expect(result).toEqual([
    { name: "Authorization", value: "Bearer tok" },
    { name: "X-API-Key", value: "key123" },
  ]);
});

test("findMatchingCredentials: no match returns empty", () => {
  const result = findMatchingCredentials(creds, "unknown.com", 443, "GET", "/");
  expect(result).toEqual([]);
});
