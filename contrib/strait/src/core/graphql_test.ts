import { describe, expect, test } from "bun:test";
import {
  GITHUB_LEAF_PATHS,
  judgeGraphql,
  LINKED_TITLE_LEAF_PATHS,
  leafPaths,
} from "./graphql.ts";
import { decide, hasDuplicateMember } from "./policy.ts";
import gh from "./testdata/gh_queries.json";

const allowedRepo = (owner: string, name: string) =>
  `${owner}/${name}`.toLowerCase() === "my-org/private-repo";

function judge(query: string, variables?: unknown) {
  return judgeGraphql(
    variables === undefined ? { query } : { query, variables },
    allowedRepo,
  );
}

const repo = (inner: string) =>
  `query { repository(owner: "my-org", name: "private-repo") { ${inner} } }`;

describe("gh's own queries", () => {
  const ours = (o: string, n: string) =>
    `${o}/${n}`.toLowerCase() === "hogeyama/nix-agent-sandbox";
  for (const r of gh.requests) {
    const body = { query: r.query, variables: r.variables };
    const linked = (leafPaths(r.query) ?? []).some((p) =>
      LINKED_TITLE_LEAF_PATHS.has(p),
    );
    test(`gh ${r.gh}: ${r.command}`, () => {
      expect(judgeGraphql(body, ours, { trustLinkedIssues: true })).toEqual({
        ok: true,
      });
      if (linked) {
        const held = judgeGraphql(body, ours);
        expect(held.ok).toBe(false);
        if (!held.ok) expect(held.reason).toContain("/title");
      } else {
        expect(judgeGraphql(body, ours)).toEqual({ ok: true });
      }
    });
  }

  test("the allowed leaves are exactly the ones gh asked for", () => {
    const asked = new Set(gh.requests.flatMap((r) => leafPaths(r.query) ?? []));
    const listed = new Set([...GITHUB_LEAF_PATHS, ...LINKED_TITLE_LEAF_PATHS]);
    expect([...listed].sort()).toEqual([...asked].sort());
  });

  test("linked issues' titles are held unless trusted, and nothing else", () => {
    for (const p of LINKED_TITLE_LEAF_PATHS) {
      expect(p.endsWith("/title")).toBe(true);
      expect(GITHUB_LEAF_PATHS.has(p)).toBe(false);
    }
  });
});

describe("trustLinkedIssues", () => {
  const linked = repo(
    "issueOrPullRequest(number: 1) { ... on Issue { parent { title } } }",
  );
  test("off by default: a linked issue's title goes to review", () => {
    expect(judge(linked).ok).toBe(false);
  });
  test("on: a linked issue's title is allowed", () => {
    expect(
      judgeGraphql({ query: linked }, allowedRepo, { trustLinkedIssues: true }),
    ).toEqual({ ok: true });
  });
  test("on: still nothing more of the linked issue than its title", () => {
    const body = repo(
      "issueOrPullRequest(number: 1) { ... on Issue { parent { title body } } }",
    );
    expect(
      judgeGraphql({ query: body }, allowedRepo, { trustLinkedIssues: true })
        .ok,
    ).toBe(false);
  });
});

type Case = [name: string, query: string, variables?: unknown];

function allows(cases: Case[]) {
  for (const [name, query, variables] of cases) {
    test(name, () => expect(judge(query, variables)).toEqual({ ok: true }));
  }
}

function refuses(cases: Case[]) {
  for (const [name, query, variables] of cases) {
    test(name, () => expect(judge(query, variables).ok).toBe(false));
  }
}

describe("allowed", () => {
  allows([
    ["a listed leaf", repo("name")],
    [
      "a subset of the listed paths",
      repo("pullRequest(number: 1) { title body }"),
    ],
    [
      "an alias of a listed field",
      repo("t: pullRequest(number: 1) { heading: title }"),
    ],
    [
      "owner and name from variables",
      `query Q($o: String!, $n: String!) { repository(owner: $o, name: $n) { name } }`,
      { o: "my-org", n: "private-repo" },
    ],
    [
      "owner from a declared default",
      `query Q($o: String = "my-org") { repository(owner: $o, name: "private-repo") { name } }`,
    ],
    [
      "owner and name compared case-insensitively",
      `{ repository(owner: "My-Org", name: "Private-Repo") { name } }`,
    ],
    ["the viewer's login", "{ viewer { login } }"],
    [
      "gh's schema probe",
      '{ Release: __type(name: "Release") { fields { name } } }',
    ],
    [
      "a fragment under a listed parent",
      `${repo("pullRequest(number: 1) { ...F }")} fragment F on PullRequest { title }`,
    ],
    [
      "skip and include",
      repo("name @skip(if: true) description @include(if: false)"),
    ],
  ]);
});

describe("reasons list every violation", () => {
  test("each disallowed field at its topmost path, in document order", () => {
    expect(
      judge(
        repo(
          "name owner { repositories(first: 1) { nodes { name } } } forks { totalCount } stargazers { totalCount }",
        ),
      ),
    ).toEqual({
      ok: false,
      reason:
        "GraphQL fields /repository/owner/repositories, /repository/forks, /repository/stargazers are not allowed",
    });
  });
  test("a disallowed field is named once however often it appears", () => {
    expect(
      judge(repo("forks { totalCount } f2: forks { totalCount }")),
    ).toEqual({
      ok: false,
      reason: "GraphQL field /repository/forks is not allowed",
    });
  });
  test("operations, fields and repositories together", () => {
    expect(
      judge(
        `${repo("name")} mutation M { addStar(input: {}) { clientMutationId } } query O { repository(owner: "octocat", name: "hello-world") { name } viewer { email } }`,
      ),
    ).toEqual({
      ok: false,
      reason:
        "only GraphQL queries are allowed (found mutation); GraphQL fields /addStar, /viewer/email are not allowed; octocat/hello-world is not an allowed repository",
    });
  });
  test("nothing is cut off", () => {
    const fields = Array.from(
      { length: 30 },
      (_, i) => `f${i}: forks${i} { totalCount }`,
    );
    const verdict = judge(repo(fields.join(" ")));
    expect(verdict.ok).toBe(false);
    for (let i = 0; i < 30; i++) {
      expect(verdict.ok || verdict.reason).toContain(`/repository/forks${i}`);
    }
  });
});

describe("paths", () => {
  refuses([
    [
      "organization → members → stars → issues (nas A1)",
      `{ organization(login: "my-org") { membersWithRole(first: 10) { nodes { starredRepositories(first: 10) { nodes { issues(first: 10) { nodes { body } } } } } } } }`,
    ],
    [
      "repository → owner → other repositories",
      repo(
        `owner { repositories(first: 10) { nodes { object(expression: "HEAD:secret") { ... on Blob { text } } } } }`,
      ),
    ],
    [
      "PR author → the author's PRs elsewhere (nas A4)",
      repo(
        "pullRequest(number: 1) { author { ... on User { pullRequests(first: 10) { nodes { body } } } } }",
      ),
    ],
    [
      "an alias that makes a forbidden field look listed (nas A5)",
      repo("body: owner { repositories(first: 1) { nodes { name } } }"),
    ],
    [
      "one fragment under a safe and an unsafe parent (nas A6)",
      `${repo("pullRequest(number: 1) { ...F headRepository { ...F } }")} fragment F on PullRequest { title }`,
    ],
    [
      "a forbidden field hidden by an inline fragment",
      repo(
        "pullRequest(number: 1) { ... on PullRequest { timelineItems(first: 1) { totalCount } } }",
      ),
    ],
    [
      "skip does not exempt a forbidden field (nas A7)",
      repo("name forks(first: 1) @skip(if: true) { totalCount }"),
    ],
    ["a child under a listed leaf (nas A11)", repo("name { x }")],
    ["an unlisted __typename", repo("__typename")],
    ["the listed root alone", repo("")],
    ["node root", `{ node(id: "x") { id } }`],
    [
      "search root",
      `{ search(query: "x", type: REPOSITORY, first: 1) { issueCount } }`,
    ],
    ["viewer beyond login", "{ viewer { email } }"],
    [
      "another repository through the viewer",
      "{ viewer { login starredRepositories { nodes { name description } } } }",
    ],
    [
      "another repository's content through a reference",
      repo(
        "pullRequest(number: 1) { closingIssuesReferences { nodes { title body } } }",
      ),
    ],
    [
      "a schema probe beyond field names",
      '{ __type(name: "Repository") { fields { name type { name } } } }',
    ],
    ["the whole schema", "{ __schema { types { name } } }"],
    [
      "a schema probe next to another repository",
      `{ __type(name: "Release") { fields { name } } repository(owner: "octocat", name: "hello-world") { name } }`,
    ],
    [
      "a mutation, even of listed fields",
      `mutation { repository(owner: "my-org", name: "private-repo") { name } }`,
    ],
    [
      "a mutation next to a query",
      `${repo("name")} mutation M { addStar(input: {starrableId: "x"}) { clientMutationId } }`,
    ],
    [
      "a subscription",
      `subscription { repository(owner: "my-org", name: "private-repo") { name } }`,
    ],
  ]);
});

describe("repository arguments", () => {
  refuses([
    [
      "another repository",
      `{ repository(owner: "octocat", name: "hello-world") { name } }`,
    ],
    ["owner missing (nas A9)", `{ repository(name: "private-repo") { name } }`],
    ["name missing", `{ repository(owner: "my-org") { name } }`],
    [
      "one alias of two names another repository",
      `{ a: repository(owner: "my-org", name: "private-repo") { name } b: repository(owner: "octocat", name: "hello-world") { name } }`,
    ],
    [
      "owner as an undefined variable",
      `query Q($o: String) { repository(owner: $o, name: "private-repo") { name } }`,
    ],
    [
      "owner as explicit null over a default (nas A10)",
      `query Q($o: String = "my-org") { repository(owner: $o, name: "private-repo") { name } }`,
      { o: null },
    ],
    [
      "owner as a number",
      `query Q($o: String) { repository(owner: $o, name: "private-repo") { name } }`,
      { o: 1 },
    ],
    [
      "a second operation whose default names another repository",
      `query A($o: String = "my-org") { repository(owner: $o, name: "private-repo") { name } } query B($o: String = "octocat") { repository(owner: $o, name: "private-repo") { name } }`,
    ],
    [
      "owner as an enum literal",
      `{ repository(owner: my_org, name: "private-repo") { name } }`,
    ],
  ]);
});

describe("documents that cannot be analysed (nas A8)", () => {
  refuses([
    ["syntax error", "{ repository("],
    ["no operation", "fragment F on Repository { name }"],
    ["an unknown directive", repo('name @export(as: "x")')],
    [
      "an unknown directive on the operation",
      `query Q @foo ${repo("name").slice(6)}`,
    ],
    [
      "a duplicated argument",
      `{ repository(owner: "my-org", owner: "x", name: "private-repo") { name } }`,
    ],
    [
      "a duplicated variable",
      `query Q($o: String = "x", $o: String = "my-org") { repository(owner: $o, name: "private-repo") { name } }`,
    ],
    [
      "a duplicated fragment",
      `${repo("...F")} fragment F on Repository { name } fragment F on Repository { owner { repositories { totalCount } } }`,
    ],
    ["an undefined fragment", repo("...Missing")],
    [
      "a fragment cycle",
      `${repo("...A")} fragment A on Repository { ...B } fragment B on Repository { ...A }`,
    ],
    ["a schema definition", `${repo("name")} type T { a: Int }`],
    [
      "a fragment expansion over budget",
      (() => {
        // Each level spreads the next twice: 2^20 fields from a small body.
        const defs = Array.from(
          { length: 20 },
          (_, i) =>
            `fragment F${i} on Repository { ...F${i + 1} ...F${i + 1} }`,
        );
        return `${repo("...F0")} ${defs.join(" ")} fragment F20 on Repository { name }`;
      })(),
    ],
    [
      "nesting over the depth limit",
      repo(`${"pullRequest { ".repeat(40)}title${" }".repeat(40)}`),
    ],
  ]);
});

describe("request object", () => {
  const cases: [string, unknown][] = [
    ["a batch", [{ query: repo("name") }]],
    ["an extra member", { query: repo("name"), extensions: {} }],
    ["no query", { variables: {} }],
    ["a non-string query", { query: 1 }],
    ["array variables", { query: repo("name"), variables: [] }],
    ["string variables", { query: repo("name"), variables: "{}" }],
  ];
  for (const [name, body] of cases) {
    test(name, () => expect(judgeGraphql(body, allowedRepo).ok).toBe(false));
  }
  test("null variables are no variables", () => {
    expect(
      judgeGraphql({ query: repo("name"), variables: null }, allowedRepo),
    ).toEqual({
      ok: true,
    });
  });
});

describe("policy around GraphQL", () => {
  const url = "https://api.github.com/graphql";
  const body = JSON.stringify({ query: repo("name") });
  const run = (
    headers: Record<string, string>,
    b: string | null | undefined = body,
    u = url,
  ) =>
    decide(
      {
        method: "POST",
        url: u,
        headers: new Headers({
          "content-type": "application/json",
          ...headers,
        }),
        body: b,
      },
      { trustedGitHubRepos: ["my-org/private-repo"] },
      { "api.github.com": "authorization" },
    ).action;

  test("allowed with the issued token", () => {
    expect(run({ authorization: "token fake_value_gh" })).toBe("allow");
  });
  test("an unlisted query goes to review, with the reason", () => {
    const d = decide(
      {
        method: "POST",
        url,
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ query: "{ viewer { email } }" }),
      },
      { trustedGitHubRepos: ["my-org/private-repo"] },
      {},
    );
    expect(d).toEqual({
      action: "review",
      reason: "GraphQL field /viewer/email is not allowed",
    });
  });
  test("charset=utf-8 is fine", () => {
    expect(run({ "content-type": "application/json; charset=utf-8" })).toBe(
      "allow",
    );
  });
  test("a foreign token does not select upstream authentication", () => {
    expect(run({ authorization: "token other" })).toBe("allow");
  });
  test("another content type", () => {
    expect(run({ "content-type": "text/plain" })).toBe("deny");
  });
  test("another charset", () => {
    expect(run({ "content-type": "application/json; charset=utf-16" })).toBe(
      "deny",
    );
  });
  test("an encoded body", () => {
    expect(run({ "content-encoding": "gzip" })).toBe("deny");
  });
  test("a body that was not read", () => {
    expect(run({}, null)).toBe("deny");
  });
  test("not JSON", () => {
    expect(run({}, "query { x }")).toBe("deny");
  });
  test("a query string", () => {
    expect(run({}, body, `${url}?query=x`)).toBe("deny");
  });
  test("a duplicated query member", () => {
    const dup = `{"query":${JSON.stringify(repo("name"))},"query":"{ viewer { login } }"}`;
    expect(run({}, dup)).toBe("deny");
  });
});

describe("hasDuplicateMember", () => {
  const cases: [string, boolean][] = [
    ['{"a":1,"b":2}', false],
    ['{"a":1,"a":2}', true],
    ['{"a":{"b":1},"b":2}', false],
    ['{"a":{"b":1,"b":2}}', true],
    ['[{"a":1},{"a":1}]', false],
    ['{"a":"\\"a\\"","\\u0061":1}', true],
    ['{"a":["x","a"],"b":"a"}', false],
  ];
  for (const [text, want] of cases) {
    test(text, () => expect(hasDuplicateMember(text)).toBe(want));
  }
});
