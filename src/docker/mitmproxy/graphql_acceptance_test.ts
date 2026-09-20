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
import type { AuthzConfig, RuleConfig } from "../../network/authz/config.ts";
import {
  GRAPHQL_TABLE_CASES,
  GRAPHQL_TABLE_LIMITS,
  type GraphqlTruth,
  githubGraphqlExample,
  REFUSED_FORK_DISGUISES,
  REPO_GRAPHQL_CASES,
  repoGithubApiExample,
  SPEC_GRAPHQL_CONDITION,
  STARRED_CROSSING_QUERY,
  STARRED_CROSSING_REFUSED_LEAVES,
} from "../../network/authz/examples_fixture.ts";
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
  readonly method?: string;
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
    method: case_.method ?? "POST",
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
 * 承認を他のリクエストへ広げてはならない事実 (許されない operation・取得経路・
 * 経路引数、解析できない document、クエリ文字列) はリクエストごとの UUID を
 * 値に持つ。比べられるよう、それを表示名の事実に置き換える。
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
  'query($o: String!) { repository(owner: $o, name: "x") { issues(first: 10) { nodes { body } } } }';

test.skipIf(!python3 || !vendoredDeps)(
  "the spec's GraphQL example resolves, and the addon accepts and enforces it",
  async () => {
    const { valid, results } = await runAddon(
      resolved(githubGraphqlExample()),
      [
        { name: "read", body: { query: READ, variables: { o: "my-org" } } },
        {
          name: "literal-read",
          body: { query: 'query { organization(login: "my-org") { login } }' },
        },
        {
          // spec の反例。入口の organization は許可した引数を満たすが、
          // member の star から第三者の本文へ出る経路は許可していない。
          name: "starred-crossing",
          body: { query: STARRED_CROSSING_QUERY },
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
            query: "query($p: String!) { organization(login: $p) { login } }",
            variables: { o: "my-org", p: "other-org" },
          },
        },
        {
          // variables に無い直書きの値も見る。
          name: "other-org-literal",
          body: {
            query: 'query { organization(login: "other-org") { login } }',
            variables: { o: "my-org" },
          },
        },
        {
          // 必須引数を書かない出現。欠落は解決不能ではなく偽であり、
          // 違反の理由も (missing) で分かれる。
          name: "owner-omitted",
          body: {
            query:
              '{ repository(name: "x") { issues(first: 10) { nodes { body } } } }',
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
    // 経路違反は許可外の末端ごとに 1 件。operation の違反と同時に出る。
    expect(summary(results.get("mutation"))).toEqual({
      decision: ["github.graphql", "allow", "rule"],
      inspection: ["review", "violations-review"],
      findings: [
        ["body", "schema-mismatch", "/query", "<uuid operation:mutation>", 1],
        [
          "body",
          "schema-mismatch",
          "/query",
          "<uuid fieldPath:/deleteRepository>",
          1,
        ],
      ],
    });
    // 入口の引数を満たしても、そこから伸びる経路は自動許可にならない。
    expect(summary(results.get("starred-crossing"))).toEqual({
      decision: ["github.graphql", "allow", "rule"],
      inspection: ["review", "violations-review"],
      findings: STARRED_CROSSING_REFUSED_LEAVES.map((path) => [
        "body",
        "schema-mismatch",
        "/query",
        `<uuid fieldPath:${path}>`,
        1,
      ]),
    });
    for (const [name, label] of [
      ["other-org-variable", "fieldArgument:/repository@owner=(not-allowed)"],
      [
        "other-org-renamed-variable",
        "fieldArgument:/organization@login=(not-allowed)",
      ],
      ["other-org-literal", "fieldArgument:/organization@login=(not-allowed)"],
      ["owner-omitted", "fieldArgument:/repository@owner=(missing)"],
    ]) {
      expect([name, summary(results.get(name))]).toEqual([
        name,
        {
          decision: ["github.graphql", "allow", "rule"],
          inspection: ["review", "violations-review"],
          findings: [
            ["body", "schema-mismatch", "/query", `<uuid ${label}>`, 1],
          ],
        },
      ]);
    }
    // 許可外の owner を 2 回承認しても、値は毎回別の UUID になる (A13)。
    expect(results.get("other-org-variable")?.findings[0]?.value).not.toBe(
      results.get("other-org-literal")?.findings[0]?.value,
    );
    expect(summary(results.get("no-variables")).findings).toEqual([
      [
        "body",
        "schema-mismatch",
        "/query",
        "<uuid fieldArgument:/repository@owner=(unresolved)>",
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
                  fieldPaths: [
                    "/repository/issues/nodes/body",
                    "/viewer/login",
                    "/rateLimit/remaining",
                    "/organization/login",
                  ],
                  fieldArguments: {
                    "/repository": { owner: ["my-org"] },
                    "/organization": { login: ["my-org"] },
                  },
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
  "fieldPaths and fieldArguments refuse reads outside the allowed paths",
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
        // 引数の実値は label に載らないので、リクエスト由来の文字列が label に
        // 入る唯一の場所は経路である。その経路に秘密の綴りを置いてマスクを通す。
        name: "masked-path",
        body: {
          query: '{ repository(owner: "my-org", name: "x") { tok_s3cret_v } }',
        },
        maskValues: ["tok_s3cret_v"],
      },
      {
        // 許可外の owner が秘密そのものでも、label は理由だけを載せる。
        name: "secret-owner",
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
    expect(refused("node")).toEqual(["<uuid fieldPath:/node/id>"]);
    expect(refused("root-fragment")).toEqual(["<uuid fieldPath:/node/id>"]);
    expect(refused("other-owner")).toEqual([
      "<uuid fieldArgument:/repository@owner=(not-allowed)>",
    ]);
    expect(refused("unresolved-owner")).toEqual([
      "<uuid fieldArgument:/repository@owner=(unresolved)>",
    ]);
    expect(refused("secret-owner")).toEqual([
      "<uuid fieldArgument:/repository@owner=(not-allowed)>",
    ]);
    // 経路に現れたリクエスト由来の名前は、既存のマスクと文字数上限を通る。
    expect(refused("masked-path")).toEqual([
      "<uuid fieldPath:/repository/****>",
    ]);
    // alias は捨てるので `a:` と `b:` の 2 出現は 1 つの経路に畳まれる。
    expect(refused("many-violations")).toEqual([
      "<uuid operation:mutation>",
      "<uuid fieldPath:/node/id>",
      "<uuid fieldPath:/search/issueCount>",
    ]);

    // document の本文は違反レコードに載らない。値は正準形の短い文字列だけで、抜粋は無い。
    for (const result of results.values()) {
      const text = JSON.stringify(result.findings);
      expect(text).not.toContain("marker-in-document");
      expect(text).not.toContain("MDEwOlJlcG9z");
      expect(text).not.toContain("s3cret");
      // 引数の実値は理由に置き換わるので、そもそも載らない。
      expect(text).not.toContain("other-org");
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
                  fieldPaths: ["/repository/issues/nodes/body"],
                  fieldArguments: { "/repository": { owner: ["my-org"] } },
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
              body: {
                format: "json",
                graphql: { operations: ["query"], fieldPaths: ["/a/b"] },
              },
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
        code: "graphql-unresolved-field-argument",
        pointer: "/query",
        fieldPath: "/repository",
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

/**
 * 同じ GraphQL 条件を `match` と `expect` の両側に置いた設定。
 *
 * 予算も document も variables も共通なので、2 つの答えの差は「条件をどちらに
 * 置いたか」からしか来ない。`match` 側は scope の fallback を deny にして
 * あるので、真・偽・判定不能が 3 通りの決定に分かれて観測できる。
 */
function tableConfig(side: "match" | "expect"): AuthzConfig {
  const rule: RuleConfig = {
    match: {
      methods: ["POST"],
      paths: ["/graphql"],
      body:
        side === "match"
          ? { format: "json", graphql: SPEC_GRAPHQL_CONDITION }
          : { format: "json" },
    },
    onMatch: "allow",
    onIndeterminate: "review",
    limits: { ...GRAPHQL_TABLE_LIMITS },
    ...(side === "expect"
      ? {
          expect: [
            {
              kind: "body" as const,
              graphql: SPEC_GRAPHQL_CONDITION,
              onViolation: "review" as const,
            },
          ],
        }
      : {}),
  };
  return {
    network: {
      scopes: {
        github: {
          targets: ["api.github.com"],
          fallback: "deny",
          rules: { read: rule },
        },
      },
    },
  };
}

/** `match` に置いた条件の真理値が、決定として見える形。 */
const MATCH_DECISION: Readonly<Record<GraphqlTruth, readonly string[]>> = {
  true: ["github.read", "allow", "rule"],
  false: ["github.$fallback", "deny", "scope-fallback"],
  indeterminate: ["github.read", "review", "indeterminate"],
};

function decisionOf(result: CaseResult): readonly string[] {
  return [result.ruleId, result.action, result.reason];
}

test.skipIf(!python3 || !vendoredDeps)(
  "the expectation table holds on both sides of the same GraphQL condition",
  async () => {
    const cases: Case[] = GRAPHQL_TABLE_CASES.map((case_) => ({
      name: case_.name,
      body: case_.body,
      ...(case_.path === undefined ? {} : { path: case_.path }),
    }));
    const matched = await runAddon(resolved(tableConfig("match")), cases);
    const inspected = await runAddon(resolved(tableConfig("expect")), cases);
    expect([matched.valid, inspected.valid]).toEqual([true, true]);

    const truths = new Set<GraphqlTruth>();
    for (const case_ of GRAPHQL_TABLE_CASES) {
      truths.add(case_.matchTruth);
      const matchResult = matched.results.get(case_.name);
      if (matchResult === undefined) throw new Error(`missing ${case_.name}`);
      const expectResult = inspected.results.get(case_.name);
      if (expectResult === undefined) throw new Error(`missing ${case_.name}`);

      // match に置いた条件は、真・偽・判定不能がそのままルール選択に出る。
      expect([case_.name, ...decisionOf(matchResult)]).toEqual([
        case_.name,
        ...MATCH_DECISION[case_.matchTruth],
      ]);
      // match は違反レコードを作らない。broker へ渡す文字列を増やさない。
      expect([case_.name, matchResult.findings]).toEqual([case_.name, []]);

      // expect に置いた条件は、同じ document をルールの受理条件として見る。
      expect([case_.name, ...decisionOf(expectResult)]).toEqual([
        case_.name,
        "github.read",
        "allow",
        "rule",
      ]);
      expect([case_.name, expectResult.inspection]).toEqual([
        case_.name,
        case_.violations.length === 0
          ? ["pass", "recognized-json"]
          : ["review", "violations-review"],
      ]);
      expect([
        case_.name,
        expectResult.findings.map((finding) => [finding.kind, finding.label]),
      ]).toEqual([
        case_.name,
        case_.violations.map((violation) => [violation.kind, violation.label]),
      ]);
      // GraphQL の違反はどれもリクエストごとの UUID を値に持ち、抜粋を持たず、
      // 条件の `at` だけを指す。
      for (const finding of expectResult.findings) {
        expect([case_.name, finding.excerpt]).toEqual([case_.name, null]);
        expect([case_.name, finding.at, finding.pointer]).toEqual([
          case_.name,
          "/query",
          "/query",
        ]);
        expect(finding.value ?? "").toMatch(UUID);
      }

      // 真理値 (`_graphql_selection_satisfies`) と違反の列挙
      // (`_graphql_selection_violations`) は addon の中で別々に書かれている。
      // 片方だけが case を見落とすと、真理値が偽の document が違反 0 件で
      // 自動的に通る。その同値を全行について要求する。
      expect([case_.name, case_.matchTruth === "true"]).toEqual([
        case_.name,
        expectResult.findings.length === 0,
      ]);
    }
    // 表が片側に偏っていたら上の同値は何も言わない。3 値すべてを含むこと。
    expect([...truths].sort()).toEqual(["false", "indeterminate", "true"]);

    // 禁止 field を alias・fragment・skip/include で隠しても、元の禁止 query と
    // 同じ答えになる。両側で同じであることまで要求する。
    for (const run of [matched, inspected]) {
      const base = summary(run.results.get("refused-fork-base"));
      for (const name of REFUSED_FORK_DISGUISES) {
        expect([name, summary(run.results.get(name))]).toEqual([name, base]);
      }
    }
  },
);

/** 解決済みドキュメントの、指定した側の GraphQL 条件だけを壊して返す。 */
function withBrokenGraphqlCondition(
  document: ResolvedDocument,
  side: "match" | "expect",
  mutate: (condition: Record<string, unknown>) => void,
): ResolvedDocument {
  const copy = JSON.parse(JSON.stringify(document)) as ResolvedDocument;
  const rule = copy.scopes[0]?.rules[0];
  if (rule === undefined) throw new Error("fixture lost its rule");
  const holder = (side === "match"
    ? rule.match
    : rule.expect[0]) as unknown as { graphql: Record<string, unknown> };
  mutate(holder.graphql);
  return copy;
}

/** 経路を落とす / 旧キーを混ぜる、設定の壊し方。 */
const BROKEN_CONDITIONS: readonly (readonly [
  string,
  (condition: Record<string, unknown>) => void,
])[] = [
  [
    "fieldPaths removed",
    (condition) => {
      delete condition.fieldPaths;
    },
  ],
  [
    "old rootFields added",
    (condition) => {
      condition.rootFields = ["repository"];
    },
  ],
  [
    "fieldPaths replaced by rootFields",
    (condition) => {
      delete condition.fieldPaths;
      condition.rootFields = ["repository"];
    },
  ],
];

test.skipIf(!python3 || !vendoredDeps)(
  "a GraphQL condition without fieldPaths, or carrying the old keys, is refused outright",
  async () => {
    // ホスト側。旧キーだけの設定も、経路を持たない設定も解決できない。
    // 旧キーは `GraphqlMatch` に無いので、型を通さずに設定へ入れる。
    // `match` に置いても `expect` に置いても同じである。
    for (const [name, condition] of [
      [
        "old keys",
        {
          operations: ["query"],
          rootFields: ["repository"],
          arguments: { owner: ["my-org"] },
        },
      ],
      ["no fieldPaths", { operations: ["query"] }],
      ["empty fieldPaths", { operations: ["query"], fieldPaths: [] }],
    ] as const) {
      for (const side of ["match", "expect"] as const) {
        const graphql = condition as unknown as typeof SPEC_GRAPHQL_CONDITION;
        const outcome = resolveAuthzConfig({
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
                      body:
                        side === "match"
                          ? { format: "json", graphql }
                          : { format: "json" },
                    },
                    onMatch: "allow",
                    ...(side === "expect"
                      ? {
                          expect: [
                            {
                              kind: "body" as const,
                              graphql,
                              onViolation: "review" as const,
                            },
                          ],
                        }
                      : {}),
                  },
                },
              },
            },
          },
        });
        expect([
          `${name} in ${side}`,
          outcome.diagnostics
            .filter((diagnostic) => diagnostic.severity === "error")
            .some((diagnostic) => diagnostic.message.includes("fieldPaths")),
          outcome.document,
        ]).toEqual([`${name} in ${side}`, true, null]);
      }
    }

    // addon 側。ホストが書き出した形を addon は信じ直す。経路を落とす、
    // 旧キーを混ぜる、どちらもドキュメント全体の拒否になり、1 件も評価しない。
    for (const side of ["match", "expect"] as const) {
      const valid = resolved(tableConfig(side));
      for (const [name, mutate] of BROKEN_CONDITIONS) {
        const outcome = await runAddon(
          withBrokenGraphqlCondition(valid, side, mutate),
          [
            {
              name: "read",
              body: { query: "{ repository { nameWithOwner } }" },
            },
          ],
        );
        expect([
          `${name} in ${side}`,
          outcome.valid,
          outcome.results.size,
        ]).toEqual([`${name} in ${side}`, false, 0]);
      }
    }
  },
);

/**
 * A19: このリポジトリ自身の `github-api` スコープを addon に通す。
 *
 * 設定は `repoGithubApiExample()` が写した `.nas/config.pkl` の `github-api`
 * スコープで、GraphQL の条件は `REPO_GRAPHQL_CONDITION` である。実ファイルが
 * その条件に解決されることは `src/config/repo_pkl_test.ts` が pkl で評価して
 * 確かめる。claude / codex / copilot / anthropic-policy-demo の 4 プロファイルは
 * `commonNetwork` 経由でこのスコープを共有するので、条件がプロファイルごとに
 * 同じ形へ落ちることも `repo_pkl_test.ts` の側で確かめる。
 *
 * REST を同じドキュメントに入れてあるのは、GraphQL の経路制限が REST の境界を
 * 動かしていないことを分けて見るためである。`/users/Hogeyama/starred` は今まで
 * どおり自動許可で、第三者の README は `/repos/{owner}/**` の capture に当たらず
 * スコープの fallback で確認に回る。**これは GitHub 通信全体の安全保証では
 * ない。** starred の一覧には第三者の description が入り、許可した Issue 本文にも
 * 外部投稿者が書いた文字列が入る。
 */
test.skipIf(!python3 || !vendoredDeps)(
  "this repository's own github-api scope allows the listed field paths and leaves REST where it was",
  async () => {
    const { valid, results } = await runAddon(
      resolved(repoGithubApiExample()),
      [
        ...REPO_GRAPHQL_CASES.map((case_) => ({
          name: case_.name,
          body: case_.body,
        })),
        // REST の既存境界。GraphQL 側の変更で動いていないことを見る。
        {
          name: "rest-own-starred",
          method: "GET",
          path: "/users/Hogeyama/starred",
          body: "",
        },
        {
          name: "rest-third-party-readme",
          method: "GET",
          path: "/repos/other/repo/readme",
          body: "",
        },
      ],
    );
    expect(valid).toBe(true);

    const truths = new Set<GraphqlTruth>();
    for (const case_ of REPO_GRAPHQL_CASES) {
      truths.add(case_.matchTruth);
      const result = results.get(case_.name);
      if (result === undefined) throw new Error(`missing ${case_.name}`);
      // 条件は expect にあるので、入口のルールは常にこの 1 本が引き受ける。
      expect([case_.name, ...decisionOf(result)]).toEqual([
        case_.name,
        "github-api.graphql.read",
        "allow",
        "rule",
      ]);
      expect([case_.name, result.inspection]).toEqual([
        case_.name,
        case_.violations.length === 0
          ? ["pass", "recognized-json"]
          : ["review", "violations-review"],
      ]);
      expect([
        case_.name,
        result.findings.map((finding) => [finding.kind, finding.label]),
      ]).toEqual([
        case_.name,
        case_.violations.map((violation) => [violation.kind, violation.label]),
      ]);
      for (const finding of result.findings) {
        expect([case_.name, finding.excerpt]).toEqual([case_.name, null]);
        expect(finding.value ?? "").toMatch(UUID);
      }
      // 真理値と違反の同値。片方だけ case を落とすと fail-open になる。
      expect([case_.name, case_.matchTruth === "true"]).toEqual([
        case_.name,
        result.findings.length === 0,
      ]);
    }
    // 許可と確認の両方を含む表であること。全部 allow / 全部 review の表は
    // 上の同値を空振りさせる。
    expect([...truths].sort()).toEqual(["false", "true"]);

    const restAllowed = results.get("rest-own-starred");
    if (restAllowed === undefined) throw new Error("missing rest-own-starred");
    expect(decisionOf(restAllowed)).toEqual([
      "github-api.owned.rest-read",
      "allow",
      "rule",
    ]);
    const restReviewed = results.get("rest-third-party-readme");
    if (restReviewed === undefined) {
      throw new Error("missing rest-third-party-readme");
    }
    expect(decisionOf(restReviewed)).toEqual([
      "github-api.$fallback",
      "review",
      "scope-fallback",
    ]);
  },
);
