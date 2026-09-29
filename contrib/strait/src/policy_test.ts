import { describe, expect, test } from "bun:test";
import { decide, type PolicyConfig, type Sentinels } from "./policy.ts";

const config: PolicyConfig = { githubRepos: ["my-org/private-repo"] };
const s: Sentinels = {
  githubToken: "fake_value_gh",
  gitAuthorization: "fake_value_git",
  anthropicOauth: "fake_value_oauth",
  anthropicApiKey: "fake_value_key",
};

type Case = [
  name: string,
  method: string,
  url: string,
  headers: Record<string, string> | [string, string][],
  expected: "allow" | "deny",
];

function run(cases: Case[]) {
  for (const [name, method, url, headers, expected] of cases) {
    test(name, () => {
      const d = decide(
        { method, url, headers: new Headers(headers) },
        config,
        s,
      );
      expect(d.action).toBe(expected);
    });
  }
}

const repo = "https://api.github.com/repos/my-org/private-repo";
const git = "https://github.com/my-org/private-repo";

describe("transport", () => {
  run([
    [
      "plain http is denied",
      "GET",
      "http://api.github.com/repos/my-org/private-repo",
      {},
      "deny",
    ],
    [
      "non-443 port is denied",
      "GET",
      "https://api.github.com:8443/repos/my-org/private-repo",
      {},
      "deny",
    ],
    [
      "explicit :443 is fine",
      "GET",
      "https://api.github.com:443/repos/my-org/private-repo",
      {},
      "allow",
    ],
    [
      "userinfo in URL is denied",
      "GET",
      "https://x:y@api.github.com/repos/my-org/private-repo",
      {},
      "deny",
    ],
    ["unknown host is denied", "GET", "https://example.com/", {}, "deny"],
    [
      "look-alike host is denied",
      "GET",
      "https://api.github.com.evil.example/repos/my-org/private-repo",
      {},
      "deny",
    ],
  ]);
});

describe("canonical request target", () => {
  run([
    [
      "dot segment escape is denied",
      "GET",
      "https://api.github.com/repos/octocat/hello-world/x/../../../my-org/private-repo",
      {},
      "deny",
    ],
    [
      "encoded dot segment is denied",
      "GET",
      "https://api.github.com/repos/octocat/hello-world/x/%2e%2e/%2e%2e/%2e%2e/my-org/private-repo",
      {},
      "deny",
    ],
    [
      "backslash is denied",
      "GET",
      "https://api.github.com/repos\\octocat\\hello-world",
      {},
      "deny",
    ],
    [
      "empty query marker is denied",
      "GET",
      "https://api.github.com/repos/my-org/private-repo?",
      {},
      "deny",
    ],
    [
      "canonical query is fine",
      "GET",
      "https://api.github.com/repos/my-org/private-repo/issues?state=open&per_page=1",
      {},
      "allow",
    ],
  ]);
});

describe("credentials", () => {
  run([
    ["no credential is allowed", "GET", repo, {}, "allow"],
    [
      "gh token form",
      "GET",
      repo,
      { authorization: "token fake_value_gh" },
      "allow",
    ],
    [
      "gh bearer form, any scheme case",
      "GET",
      repo,
      { authorization: "BEARER fake_value_gh" },
      "allow",
    ],
    [
      "foreign token is denied",
      "GET",
      repo,
      { authorization: "Bearer nas-a1b-invalid" },
      "deny",
    ],
    [
      "foreign Basic is denied",
      "GET",
      repo,
      { authorization: "Basic eDp5" },
      "deny",
    ],
    [
      "sentinel plus suffix is denied",
      "GET",
      repo,
      { authorization: "token fake_value_gh2" },
      "deny",
    ],
    [
      "duplicate Authorization is denied",
      "GET",
      repo,
      [
        ["authorization", "token fake_value_gh"],
        ["Authorization", "token attacker"],
      ],
      "deny",
    ],
    [
      "another host's sentinel is denied",
      "GET",
      repo,
      { authorization: "Bearer fake_value_oauth" },
      "deny",
    ],
    ["cookie is denied", "GET", repo, { cookie: "user_session=x" }, "deny"],
    [
      "access_token query is denied",
      "GET",
      `${repo}?access_token=x`,
      {},
      "deny",
    ],
    [
      "x-api-key to GitHub is denied",
      "GET",
      repo,
      { "x-api-key": "fake_value_key" },
      "deny",
    ],
    [
      "git auth must be the whole issued value",
      "POST",
      `${git}.git/git-upload-pack`,
      { authorization: "fake_value_git" },
      "allow",
    ],
    [
      "gh token is not accepted by git",
      "POST",
      `${git}.git/git-upload-pack`,
      { authorization: "token fake_value_gh" },
      "deny",
    ],
    [
      "anthropic oauth",
      "POST",
      "https://api.anthropic.com/v1/messages",
      { authorization: "Bearer fake_value_oauth" },
      "allow",
    ],
    [
      "anthropic foreign key is denied",
      "POST",
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": "sk-ant-attacker" },
      "deny",
    ],
    [
      "anthropic issued key",
      "POST",
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": "fake_value_key" },
      "allow",
    ],
  ]);

  test("nothing is accepted when no credential was issued", () => {
    const d = decide(
      {
        method: "GET",
        url: repo,
        headers: new Headers({ authorization: "token fake_value_gh" }),
      },
      config,
      {},
    );
    expect(d.action).toBe("deny");
  });
});

describe("GitHub API", () => {
  run([
    ["repo root", "GET", repo, {}, "allow"],
    ["below the repo", "GET", `${repo}/issues?state=open`, {}, "allow"],
    ["HEAD", "HEAD", `${repo}/contents/README.md`, {}, "allow"],
    [
      "owner and repo are case-insensitive",
      "GET",
      "https://api.github.com/repos/My-Org/Private-Repo/pulls",
      {},
      "allow",
    ],
    [
      "other repo is denied",
      "GET",
      "https://api.github.com/repos/octocat/hello-world",
      {},
      "deny",
    ],
    [
      "repo name prefix is denied",
      "GET",
      "https://api.github.com/repos/my-org/private-repo-2",
      {},
      "deny",
    ],
    [
      "percent-encoded owner is denied",
      "GET",
      "https://api.github.com/repos/my%2Dorg/private-repo",
      {},
      "deny",
    ],
    [
      "/repositories/{id} is denied",
      "GET",
      "https://api.github.com/repositories/1/issues",
      {},
      "deny",
    ],
    ["/user is denied", "GET", "https://api.github.com/user", {}, "deny"],
    [
      "dot segments cannot escape",
      "GET",
      "https://api.github.com/repos/my-org/private-repo/../../octocat/hello-world",
      {},
      "deny",
    ],
    ["write is denied", "POST", `${repo}/issues`, {}, "deny"],
    ["delete is denied", "DELETE", repo, {}, "deny"],
    ["graphql is denied", "POST", "https://api.github.com/graphql", {}, "deny"],
  ]);
});

describe("git over HTTPS", () => {
  run([
    [
      "fetch discovery",
      "GET",
      `${git}.git/info/refs?service=git-upload-pack`,
      {},
      "allow",
    ],
    [
      "fetch discovery without .git",
      "GET",
      `${git}/info/refs?service=git-upload-pack`,
      {},
      "allow",
    ],
    ["fetch", "POST", `${git}.git/git-upload-pack`, {}, "allow"],
    [
      "push discovery is denied",
      "GET",
      `${git}.git/info/refs?service=git-receive-pack`,
      {},
      "deny",
    ],
    [
      "duplicated service parameter is denied",
      "GET",
      `${git}.git/info/refs?service=git-upload-pack&service=git-receive-pack`,
      {},
      "deny",
    ],
    ["push is denied", "POST", `${git}.git/git-receive-pack`, {}, "deny"],
    [
      "other repo fetch is denied",
      "POST",
      "https://github.com/octocat/hello-world.git/git-upload-pack",
      {},
      "deny",
    ],
    ["web page is denied", "GET", git, {}, "deny"],
  ]);
});

describe("Anthropic", () => {
  run([
    [
      "model selector without org",
      "GET",
      "https://api.anthropic.com/api/model_selector/cc",
      {},
      "allow",
    ],
    [
      "messages",
      "POST",
      "https://api.anthropic.com/v1/messages?beta=true",
      {},
      "allow",
    ],
    [
      "bootstrap",
      "GET",
      "https://api.anthropic.com/api/claude_cli/bootstrap",
      {},
      "allow",
    ],
    [
      "wildcard segment",
      "GET",
      "https://api.anthropic.com/api/organizations/abc/model_selector/cc",
      {},
      "allow",
    ],
    [
      "wildcard is one segment",
      "GET",
      "https://api.anthropic.com/api/organizations/a/b/model_selector/cc",
      {},
      "deny",
    ],
    [
      "files API upload is denied",
      "POST",
      "https://api.anthropic.com/v1/files",
      {},
      "deny",
    ],
    [
      "files API list is denied",
      "GET",
      "https://api.anthropic.com/v1/files",
      {},
      "deny",
    ],
    [
      "wrong method is denied",
      "GET",
      "https://api.anthropic.com/v1/messages",
      {},
      "deny",
    ],
  ]);
});
