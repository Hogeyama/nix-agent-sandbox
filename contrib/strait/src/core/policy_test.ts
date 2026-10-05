import { describe, expect, test } from "bun:test";
import type { CredentialHeaders } from "./credentials.ts";
import { decide, type PolicyConfig } from "./policy.ts";

const config: PolicyConfig = { githubRepos: ["my-org/private-repo"] };
const s: CredentialHeaders = {
  "api.github.com": "authorization",
  "github.com": "authorization",
  "api.anthropic.com": "authorization",
};

type Case = [
  name: string,
  method: string,
  url: string,
  headers: Record<string, string> | [string, string][],
  expected: "allow" | "deny" | "review",
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
      "foreign token is overwritable",
      "GET",
      repo,
      { authorization: "Bearer nas-a1b-invalid" },
      "allow",
    ],
    [
      "foreign Basic is overwritable",
      "GET",
      repo,
      { authorization: "Basic eDp5" },
      "allow",
    ],
    [
      "sentinel plus suffix is overwritable",
      "GET",
      repo,
      { authorization: "token fake_value_gh2" },
      "allow",
    ],
    [
      "duplicate Authorization is overwritable",
      "GET",
      repo,
      [
        ["authorization", "token fake_value_gh"],
        ["Authorization", "token attacker"],
      ],
      "allow",
    ],
    [
      "another host's sentinel is overwritable",
      "GET",
      repo,
      { authorization: "Bearer fake_value_oauth" },
      "allow",
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
      "x-api-key to GitHub is removed",
      "GET",
      repo,
      { "x-api-key": "fake_value_key" },
      "allow",
    ],
    [
      "git client auth is overwritten",
      "POST",
      `${git}.git/git-upload-pack`,
      { authorization: "fake_value_git" },
      "allow",
    ],
    [
      "git client token is overwritten",
      "POST",
      `${git}.git/git-upload-pack`,
      { authorization: "token fake_value_gh" },
      "allow",
    ],
    [
      "anthropic oauth",
      "POST",
      "https://api.anthropic.com/v1/messages",
      { authorization: "Bearer fake_value_oauth" },
      "allow",
    ],
    [
      "anthropic foreign key is removed",
      "POST",
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": "sk-ant-attacker" },
      "allow",
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
      "other repo goes to review",
      "GET",
      "https://api.github.com/repos/octocat/hello-world",
      {},
      "review",
    ],
    [
      "repo name prefix goes to review",
      "GET",
      "https://api.github.com/repos/my-org/private-repo-2",
      {},
      "review",
    ],
    [
      "percent-encoded owner goes to review",
      "GET",
      "https://api.github.com/repos/my%2Dorg/private-repo",
      {},
      "review",
    ],
    [
      "/repositories/{id} goes to review",
      "GET",
      "https://api.github.com/repositories/1/issues",
      {},
      "review",
    ],
    [
      "/user goes to review",
      "GET",
      "https://api.github.com/user",
      {},
      "review",
    ],
    [
      "dot segments cannot escape",
      "GET",
      "https://api.github.com/repos/my-org/private-repo/../../octocat/hello-world",
      {},
      "deny",
    ],
    ["write goes to review", "POST", `${repo}/issues`, {}, "review"],
    ["delete goes to review", "DELETE", repo, {}, "review"],
    [
      "graphql without a body is denied",
      "POST",
      "https://api.github.com/graphql",
      {},
      "deny",
    ],
  ]);
});

describe("every repository of one owner", () => {
  const owner: PolicyConfig = { githubRepos: ["My-Org/*"] };
  const action = (method: string, url: string) =>
    decide({ method, url, headers: new Headers() }, owner, s).action;

  test("any repository of the owner, by REST and git", () => {
    expect(action("GET", "https://api.github.com/repos/my-org/another")).toBe(
      "allow",
    );
    expect(
      action("POST", "https://github.com/my-org/another.git/git-upload-pack"),
    ).toBe("allow");
  });
  test("an owner whose name only starts the same goes to review", () => {
    expect(
      action("GET", "https://api.github.com/repos/my-org-evil/another"),
    ).toBe("review");
  });
  test("a literal * repository name does not stand for the rule", () => {
    expect(action("GET", "https://api.github.com/repos/other/*")).toBe(
      "review",
    );
  });
  test("GraphQL on any repository of the owner", () => {
    const graphql = (o: string) =>
      decide(
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: new Headers({ "content-type": "application/json" }),
          body: JSON.stringify({
            query: `{ repository(owner: "${o}", name: "another") { name } }`,
          }),
        },
        owner,
        s,
      ).action;
    expect(graphql("my-org")).toBe("allow");
    expect(graphql("octocat")).toBe("review");
  });
  test("writes still go to review", () => {
    expect(action("POST", "https://api.github.com/repos/my-org/x/issues")).toBe(
      "review",
    );
  });
});

describe("trustLinkedIssues reaches the GraphQL check", () => {
  const graphql = (trustLinkedIssues?: boolean) =>
    decide(
      {
        method: "POST",
        url: "https://api.github.com/graphql",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          query:
            '{ repository(owner: "my-org", name: "private-repo") { issueOrPullRequest(number: 1) { ... on Issue { parent { title } } } } }',
        }),
      },
      { ...config, trustLinkedIssues },
      s,
    ).action;
  test("held without it", () => expect(graphql()).toBe("review"));
  test("allowed with it", () => expect(graphql(true)).toBe("allow"));
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
      "push discovery goes to review",
      "GET",
      `${git}.git/info/refs?service=git-receive-pack`,
      {},
      "review",
    ],
    [
      "duplicated service parameter goes to review",
      "GET",
      `${git}.git/info/refs?service=git-upload-pack&service=git-receive-pack`,
      {},
      "review",
    ],
    [
      "push goes to review",
      "POST",
      `${git}.git/git-receive-pack`,
      {},
      "review",
    ],
    [
      "other repo fetch goes to review",
      "POST",
      "https://github.com/octocat/hello-world.git/git-upload-pack",
      {},
      "review",
    ],
    ["web page goes to review", "GET", git, {}, "review"],
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
      "review",
    ],
    [
      "files API upload goes to review",
      "POST",
      "https://api.anthropic.com/v1/files",
      {},
      "review",
    ],
    [
      "files API list goes to review",
      "GET",
      "https://api.anthropic.com/v1/files",
      {},
      "review",
    ],
    [
      "wrong method goes to review",
      "GET",
      "https://api.anthropic.com/v1/messages",
      {},
      "review",
    ],
  ]);
});

describe("hosts added in strait.json", () => {
  const cfg: PolicyConfig = {
    githubRepos: [],
    hosts: {
      "devapi.example.com": { credential: { header: "x-api-key" } },
      "api.example.org": {
        credential: { header: "authorization", scheme: "Bearer" },
      },
      "docs.example.com": {},
    },
  };
  const sen: CredentialHeaders = {
    "api.github.com": "authorization",
    "devapi.example.com": "x-api-key",
    "api.example.org": "authorization",
  };
  const run = (
    method: string,
    url: string,
    headers: Record<string, string> | [string, string][] = {},
  ) => decide({ method, url, headers: new Headers(headers) }, cfg, sen).action;

  test("any method and path", () => {
    expect(run("GET", "https://devapi.example.com/")).toBe("allow");
    expect(run("DELETE", "https://devapi.example.com/v1/things/1?x=y")).toBe(
      "allow",
    );
    expect(run("GET", "https://docs.example.com/guide")).toBe("allow");
  });
  test("any client credential in its header", () => {
    expect(
      run("POST", "https://devapi.example.com/v1", { "x-api-key": "fake_dev" }),
    ).toBe("allow");
    expect(
      run("GET", "https://api.example.org/", {
        authorization: "bearer fake_org",
      }),
    ).toBe("allow");
  });
  test("a foreign key is overwritten", () => {
    expect(
      run("GET", "https://devapi.example.com/", { "x-api-key": "attacker" }),
    ).toBe("allow");
    expect(
      run("GET", "https://api.example.org/", {
        authorization: "Bearer attacker",
      }),
    ).toBe("allow");
  });
  test("the credential in another header, or another host's, is overwritten", () => {
    expect(
      run("GET", "https://devapi.example.com/", {
        authorization: "Bearer fake_dev",
      }),
    ).toBe("allow");
    expect(
      run("GET", "https://devapi.example.com/", { "x-api-key": "fake_org" }),
    ).toBe("allow");
    expect(
      run("GET", "https://devapi.example.com/", {
        authorization: "token fake_value_gh",
      }),
    ).toBe("allow");
  });
  test("a host without a credential takes no client auth", () => {
    expect(
      run("GET", "https://docs.example.com/", { authorization: "Bearer x" }),
    ).toBe("deny");
    expect(run("GET", "https://docs.example.com/", { "x-api-key": "x" })).toBe(
      "deny",
    );
  });
  test("a duplicated key header is overwritten", () => {
    expect(
      run("GET", "https://devapi.example.com/", [
        ["x-api-key", "fake_dev"],
        ["x-api-key", "attacker"],
      ]),
    ).toBe("allow");
  });
  test("cookies and query-string tokens are denied", () => {
    expect(run("GET", "https://devapi.example.com/", { cookie: "s=1" })).toBe(
      "deny",
    );
    expect(run("GET", "https://devapi.example.com/?access_token=x")).toBe(
      "deny",
    );
  });
  test("transport checks still apply", () => {
    expect(run("GET", "http://devapi.example.com/")).toBe("deny");
    expect(run("GET", "https://devapi.example.com:8443/")).toBe("deny");
    expect(run("GET", "https://devapi.example.com/a/../b")).toBe("deny");
  });
  test("a name that is not configured is not allowed", () => {
    expect(run("GET", "https://devapi.example.com.evil.example/")).toBe("deny");
    expect(run("GET", "https://example.com/")).toBe("deny");
  });
  test("an inherited property name is not a host", () => {
    expect(run("GET", "https://constructor/")).toBe("deny");
  });
});

describe("Artifact content hosts", () => {
  const run = (url: string, headers: Record<string, string> = {}) =>
    decide({ method: "GET", url, headers: new Headers(headers) }, config, s);
  const host =
    "https://509165a3-f096-4ffc-8e12-5550470d17e7.frame.claudeusercontent.com";

  test("one Artifact's host goes to review", () => {
    expect(run(`${host}/`).action).toBe("review");
    expect(run(`${host}/index.html?x=1`).action).toBe("review");
  });
  test("deeper or look-alike names are not Artifact hosts", () => {
    expect(run("https://a.b.frame.claudeusercontent.com/").action).toBe("deny");
    expect(run("https://frame.claudeusercontent.com/").action).toBe("deny");
    expect(
      run("https://x.frame.claudeusercontent.com.evil.example/").action,
    ).toBe("deny");
    expect(run("https://xframe.claudeusercontent.com/").action).toBe("deny");
  });
  test("credentials are checked first", () => {
    expect(run(`${host}/`, { cookie: "s=1" }).action).toBe("deny");
    expect(
      run(`${host}/`, { authorization: "Bearer fake_value_oauth" }).action,
    ).toBe("deny");
  });
});

test("configured custom auth requires a host credential even if config names the header", () => {
  expect(
    decide(
      {
        method: "GET",
        url: "https://custom.example.com/",
        headers: new Headers({ "private-token": "attacker" }),
      },
      {
        githubRepos: [],
        hosts: {
          "custom.example.com": { credential: { header: "private-token" } },
        },
      },
      {},
    ).action,
  ).toBe("deny");
});
test("anonymous requests with no host credential remain available", () => {
  expect(
    decide({ method: "GET", url: repo, headers: new Headers() }, config, {})
      .action,
  ).toBe("allow");
});
