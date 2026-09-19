/**
 * GraphQL 条件が設定の解決から addon の受理・選択・受理条件の検査まで通ること。
 *
 * 設定を解決器に通し、ホストが addon に書き出す形 (`withoutInjectLiterals`) の
 * ドキュメントを graphql_acceptance.py に渡す。addon はそのドキュメントを
 * 検証し直し、リクエストごとに候補の真偽表・選択・受理条件の検査を行う。
 * 違反レコードは broker の検証器 (`validateViolationFindings`) にも通す。
 *
 * 選択の突き合わせ (TS の `decide` との一致) は decide_parity_test.ts の役目で
 * あり、ここでは addon が同じ解決済みドキュメントの上で期待どおりに振る舞う
 * ことだけを見る。
 */

import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { AuthzConfig } from "../../network/authz/config.ts";
import { githubGraphqlExample } from "../../network/authz/examples_fixture.ts";
import {
  type ResolvedDocument,
  resolveAuthzConfig,
  withoutInjectLiterals,
} from "../../network/authz/resolve.ts";
import {
  type ViolationFinding,
  validateViolationFindings,
} from "../../network/protocol.ts";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);
// nas_addon は ./vendor の graphql-core を import する。vendor/ は
// `bun run vendor` が作る gitignore 済みの生成物である。
const vendoredDeps = existsSync(path.join(addonDir, "vendor", "graphql"));

interface Case {
  readonly name: string;
  readonly host?: string;
  readonly path?: string;
  /** JSON にする値。文字列はそのままのバイト列として送る。 */
  readonly body: unknown;
  readonly maskValues?: readonly string[];
}

interface CaseResult {
  readonly name: string;
  readonly action: string;
  readonly reason: string;
  readonly ruleId: string;
  readonly diagnostic: Record<string, unknown> | null;
  readonly inspection: readonly [string, string] | null;
  readonly findings: readonly ViolationFinding[];
}

function resolved(config: AuthzConfig): ResolvedDocument {
  const outcome = resolveAuthzConfig(config);
  expect(outcome.diagnostics).toEqual([]);
  if (outcome.document === null) throw new Error("unresolvable config");
  return withoutInjectLiterals(outcome.document);
}

async function runAddon(
  document: ResolvedDocument,
  cases: readonly Case[],
): Promise<{ valid: boolean; results: Map<string, CaseResult> }> {
  const serialized = cases.map((case_) => ({
    name: case_.name,
    host: case_.host ?? "api.github.com",
    port: 443,
    method: "POST",
    path: case_.path ?? "/graphql",
    maskValues: case_.maskValues ?? [],
    bodyBase64: Buffer.from(
      typeof case_.body === "string" ? case_.body : JSON.stringify(case_.body),
    ).toString("base64"),
  }));
  const proc = Bun.spawn(
    [
      python3 as string,
      "graphql_acceptance.py",
      JSON.stringify(document),
      JSON.stringify(serialized),
    ],
    {
      cwd: addonDir,
      env: {
        ...process.env,
        PYTHONPATH: path.join(addonDir, "testdata", "mitmproxy_stub"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) console.error(stderr);
  expect(exitCode).toBe(0);
  const output = JSON.parse(stdout) as {
    valid: boolean;
    results: CaseResult[];
  };
  for (const result of output.results) {
    expect([result.name, validateViolationFindings(result.findings)]).toEqual([
      result.name,
      null,
    ]);
  }
  return {
    valid: output.valid,
    results: new Map(output.results.map((result) => [result.name, result])),
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 承認を他のリクエストへ広げてはならない事実 (許されない operation と
 * root field、解析できない document、解決できない引数、クエリ文字列) は
 * リクエストごとの UUID を値に持つ。比べられるよう、それを表示名の事実に置き換える。
 */
function shownValue(finding: ViolationFinding): string | null {
  if (finding.value !== null && UUID.test(finding.value)) {
    return `<uuid ${finding.label}>`;
  }
  return finding.value;
}

function summary(result: CaseResult | undefined) {
  if (result === undefined) throw new Error("missing case result");
  return {
    decision: [result.ruleId, result.action, result.reason],
    inspection: result.inspection,
    findings: result.findings.map((finding) => [
      finding.expectKind,
      finding.kind,
      finding.at,
      shownValue(finding),
      finding.count,
    ]),
  };
}

const READ =
  'query($o: String!) { repository(owner: $o, name: "x") { issues(first: 10) { nodes { title } } } }';

test.skipIf(!python3 || !vendoredDeps)(
  "the spec's GraphQL example resolves, and the addon accepts and enforces it",
  async () => {
    const { valid, results } = await runAddon(
      resolved(githubGraphqlExample()),
      [
        { name: "read", body: { query: READ, variables: { o: "my-org" } } },
        {
          name: "literal-read",
          body: { query: 'query { organization(login: "my-org") { name } }' },
        },
        {
          name: "mutation",
          body: {
            query: "mutation($o: String!) { deleteRepository(owner: $o) }",
            variables: { o: "my-org" },
          },
        },
        {
          name: "other-org-variable",
          body: { query: READ, variables: { o: "other-org" } },
        },
        {
          // 変数名が何であっても、引数に渡る値で判定する。
          name: "other-org-renamed-variable",
          body: {
            query: "query($p: String!) { organization(login: $p) { name } }",
            variables: { o: "my-org", p: "other-org" },
          },
        },
        {
          // variables に無い直書きの値も見る。
          name: "other-org-literal",
          body: {
            query: 'query { organization(login: "other-org") { name } }',
            variables: { o: "my-org" },
          },
        },
        { name: "no-variables", body: { query: READ } },
        {
          name: "unparseable-document",
          body: { query: "query {", variables: { o: "my-org" } },
        },
        {
          // 既定の maxDepth を越えて入れ子にした mutation も解析できない側に落ちる。
          name: "deep-mutation",
          body: {
            query: `mutation { ${"a { ".repeat(80)}b${" }".repeat(80)} }`,
          },
        },
        { name: "broken-json", body: '{"query":' },
        {
          // サーバが URL の document を実行するなら、ボディは読み取りでも
          // mutation が走る。
          name: "query-string-document",
          path: "/graphql?query=mutation%7BdeleteRepository%7D",
          body: { query: READ, variables: { o: "my-org" } },
        },
        {
          // `?variables=` が既定値を上書きし得るので、既定値で解決しない。
          name: "query-string-variables",
          path: "/graphql?variables=%7B%22o%22%3A%22other-org%22%7D",
          body: {
            query:
              'query($o: String = "my-org") { organization(login: $o) { name } }',
          },
        },
      ],
    );
    expect(valid).toBe(true);

    expect(summary(results.get("read"))).toEqual({
      decision: ["github.graphql", "allow", "rule"],
      inspection: ["pass", "recognized-json"],
      findings: [],
    });
    expect(summary(results.get("literal-read")).inspection).toEqual([
      "pass",
      "recognized-json",
    ]);
    expect(summary(results.get("mutation"))).toEqual({
      decision: ["github.graphql", "allow", "rule"],
      inspection: ["review", "violations-review"],
      findings: [
        ["body", "schema-mismatch", "/query", "<uuid operation:mutation>", 1],
      ],
    });
    for (const [name, value] of [
      ["other-org-variable", "argument:owner=other-org"],
      ["other-org-renamed-variable", "argument:login=other-org"],
      ["other-org-literal", "argument:login=other-org"],
    ]) {
      expect([name, summary(results.get(name))]).toEqual([
        name,
        {
          decision: ["github.graphql", "allow", "rule"],
          inspection: ["review", "violations-review"],
          findings: [["body", "schema-mismatch", "/query", value, 1]],
        },
      ]);
    }
    expect(summary(results.get("no-variables")).findings).toEqual([
      [
        "body",
        "schema-mismatch",
        "/query",
        "<uuid argument:owner=(unresolved)>",
        1,
      ],
    ]);
    expect(summary(results.get("unparseable-document")).findings).toEqual([
      [
        "body",
        "body-unavailable",
        "/query",
        "<uuid document:(unanalysable)>",
        1,
      ],
    ]);
    expect(summary(results.get("deep-mutation")).findings).toEqual([
      [
        "body",
        "body-unavailable",
        "/query",
        "<uuid document:(unanalysable)>",
        1,
      ],
    ]);
    // 解析できない document の承認は、その 1 件にしか及ばない。
    expect(results.get("deep-mutation")?.findings[0]?.value).not.toBe(
      results.get("unparseable-document")?.findings[0]?.value,
    );
    expect(summary(results.get("broken-json"))).toEqual({
      decision: ["github.graphql", "review", "indeterminate"],
      inspection: null,
      findings: [],
    });
    // クエリ文字列があれば、ボディの document を解析せずに 1 リクエスト限りの
    // 違反とし、人の確認に回す。違反レコードにクエリ文字列は載らない。
    for (const name of ["query-string-document", "query-string-variables"]) {
      const result = results.get(name);
      expect([name, summary(result)]).toEqual([
        name,
        {
          decision: ["github.graphql", "allow", "rule"],
          inspection: ["review", "violations-review"],
          findings: [
            [
              "body",
              "body-unavailable",
              "/query",
              "<uuid document:(query-string)>",
              1,
            ],
          ],
        },
      ]);
      expect(result?.findings[0]?.excerpt).toBeNull();
      const text = JSON.stringify(result?.findings);
      expect(text).not.toContain("deleteRepository");
      expect(text).not.toContain("other-org");
    }
    expect(results.get("query-string-document")?.findings[0]?.value).not.toBe(
      results.get("query-string-variables")?.findings[0]?.value,
    );
  },
);

/** 対象を組織で絞る形。条件は `expect` に置く。 */
const SCOPED_READ: AuthzConfig = {
  network: {
    scopes: {
      github: {
        targets: ["api.github.com"],
        fallback: "review",
        rules: {
          "graphql.read": {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: { format: "json" },
            },
            onMatch: "allow",
            onIndeterminate: "review",
            expect: [
              {
                kind: "body",
                graphql: {
                  operations: ["query"],
                  rootFields: ["repository", "viewer", "rateLimit"],
                  arguments: { owner: ["my-org"], login: ["my-org"] },
                },
                onViolation: "review",
              },
            ],
          },
        },
      },
    },
  },
};

test.skipIf(!python3 || !vendoredDeps)(
  "rootFields and arguments refuse reads outside the allowed entry points",
  async () => {
    const { valid, results } = await runAddon(resolved(SCOPED_READ), [
      { name: "read", body: { query: READ, variables: { o: "my-org" } } },
      {
        name: "literal-read",
        body: { query: "{ viewer { login } rateLimit { remaining } }" },
      },
      {
        name: "node",
        body: { query: '{ node(id: "MDEwOlJlcG9z") { id } }' },
      },
      {
        name: "root-fragment",
        body: {
          query:
            'query { ...f } fragment f on Query { node(id: "MDEwOlJlcG9z") { id } }',
        },
      },
      {
        name: "other-owner",
        body: { query: READ, variables: { o: "other-org" } },
      },
      {
        name: "unresolved-owner",
        body: { query: READ, variables: { o: { login: "my-org" } } },
      },
      {
        name: "masked-owner",
        body: { query: READ, variables: { o: "tok-s3cret-value" } },
        maskValues: ["tok-s3cret-value"],
      },
      {
        name: "many-violations",
        body: {
          query:
            '# marker-in-document\nmutation { a: node(id: "1") { id } b: node(id: "2") { id } search(query: "x") { issueCount } }',
        },
      },
    ]);
    expect(valid).toBe(true);

    expect(summary(results.get("read")).inspection).toEqual([
      "pass",
      "recognized-json",
    ]);
    expect(summary(results.get("literal-read")).inspection).toEqual([
      "pass",
      "recognized-json",
    ]);
    const refused = (name: string) =>
      summary(results.get(name)).findings.map((finding) => finding[3]);
    expect(refused("node")).toEqual(["<uuid rootField:node>"]);
    expect(refused("root-fragment")).toEqual(["<uuid rootField:node>"]);
    expect(refused("other-owner")).toEqual(["argument:owner=other-org"]);
    expect(refused("unresolved-owner")).toEqual([
      "<uuid argument:owner=(unresolved)>",
    ]);
    expect(refused("masked-owner")).toEqual(["argument:owner=****"]);
    expect(refused("many-violations")).toEqual([
      "<uuid operation:mutation>",
      "<uuid rootField:node>",
      "<uuid rootField:search>",
    ]);

    // document の本文は違反レコードに載らない。値は正準形の短い文字列だけで、抜粋は無い。
    for (const result of results.values()) {
      const text = JSON.stringify(result.findings);
      expect(text).not.toContain("marker-in-document");
      expect(text).not.toContain("MDEwOlJlcG9z");
      expect(text).not.toContain("s3cret");
      // 表示名を持つのは値が UUID の事実だけで、中身は違反した事実の短い名前である。
      for (const finding of result.findings) {
        expect(finding.excerpt).toBeNull();
        expect(finding.label !== null).toBe(
          finding.value !== null && UUID.test(finding.value),
        );
      }
    }
  },
);

/** 同じ条件を `match` に置いた形。外れたリクエストは fallback に落ちる。 */
const MATCH_SIDE: AuthzConfig = {
  network: {
    scopes: {
      github: {
        targets: ["api.github.com"],
        fallback: "deny",
        rules: {
          read: {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: {
                format: "json",
                graphql: {
                  operations: ["query"],
                  arguments: { owner: ["my-org"] },
                },
              },
            },
            onMatch: "allow",
            onIndeterminate: "review",
          },
        },
      },
      shallow: {
        targets: ["shallow.example"],
        fallback: "deny",
        rules: {
          read: {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: { format: "json", graphql: { operations: ["query"] } },
            },
            onMatch: "allow",
            onIndeterminate: "review",
            limits: { maxDepth: 2 },
          },
        },
      },
    },
  },
};

test.skipIf(!python3 || !vendoredDeps)(
  "a graphql match is true, false, or indeterminate under the rule's own limits",
  async () => {
    const { valid, results } = await runAddon(resolved(MATCH_SIDE), [
      { name: "read", body: { query: READ, variables: { o: "my-org" } } },
      {
        name: "mutation",
        body: { query: "mutation { deleteRepository }" },
      },
      {
        name: "unresolved-owner",
        body: { query: READ, variables: {} },
      },
      { name: "unparseable", body: { query: "query {" } },
      { name: "no-document", body: { variables: {} } },
      {
        name: "within-depth",
        host: "shallow.example",
        body: { query: "{ a { b } }" },
      },
      {
        name: "over-depth",
        host: "shallow.example",
        body: { query: "{ a { b { c } } }" },
      },
      {
        name: "query-string",
        path: "/graphql?query=mutation%7BdeleteRepository%7D",
        body: { query: READ, variables: { o: "my-org" } },
      },
      {
        name: "query-string-no-document",
        path: "/graphql?query=mutation%7BdeleteRepository%7D",
        body: { variables: {} },
      },
    ]);
    expect(valid).toBe(true);

    const decided = (name: string) => {
      const result = results.get(name);
      return [
        result?.ruleId,
        result?.action,
        result?.reason,
        result?.diagnostic,
      ];
    };
    expect(decided("read")).toEqual(["github.read", "allow", "rule", null]);
    expect(decided("mutation")).toEqual([
      "github.$fallback",
      "deny",
      "scope-fallback",
      null,
    ]);
    expect(decided("unresolved-owner")).toEqual([
      "github.read",
      "review",
      "indeterminate",
      {
        code: "graphql-unresolved-argument",
        pointer: "/query",
        argument: "owner",
      },
    ]);
    expect(decided("unparseable")).toEqual([
      "github.read",
      "review",
      "indeterminate",
      { code: "graphql-unparseable", pointer: "/query" },
    ]);
    expect(decided("no-document")).toEqual([
      "github.$fallback",
      "deny",
      "scope-fallback",
      null,
    ]);
    expect(decided("within-depth")).toEqual([
      "shallow.read",
      "allow",
      "rule",
      null,
    ]);
    expect(decided("over-depth")).toEqual([
      "shallow.read",
      "review",
      "indeterminate",
      { code: "graphql-unparseable", pointer: "/query" },
    ]);
    // クエリ文字列があれば、ボディの document の有無によらず判定不能。
    // 診断は条件の `at` だけを名指しし、URL を載せない。
    for (const name of ["query-string", "query-string-no-document"]) {
      expect([name, ...decided(name)]).toEqual([
        name,
        "github.read",
        "review",
        "indeterminate",
        { code: "graphql-query-string", pointer: "/query" },
      ]);
    }
  },
);
