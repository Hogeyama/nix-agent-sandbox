/**
 * addon が送るメッセージを、broker の検証器がそのまま受け取れること。
 *
 * 違反の確認は 2 プロセスに跨る。addon がボディを検査して違反レコードを組み立て、
 * broker がそれを検証してから人に出す。broker はフィールド 1 つ知らないだけで
 * メッセージを丸ごと拒み、addon は拒まれたリクエストを通さないので、形の
 * ずれは「間違った答え」ではなく「動かないセッション」になる。
 *
 * 片側だけのテストではこれを捕まえられない。python 側は自分が作った dict を
 * 見るだけで、TypeScript 側は手で書いた違反レコードを見るだけだからである。ここでは
 * **実際の検査が出した**違反レコードからメッセージを組み立てさせ、broker の検証器に
 * 通す。
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { MAX_BODY_EXPECT_POINTER_CHARS } from "../../network/authz/config.ts";
import {
  type ResolvedDocument,
  resolveAuthzConfig,
  withoutInjectLiterals,
} from "../../network/authz/resolve.ts";
import {
  type ViolationFinding,
  validateAuthorizeRequest,
  validateRequestPolicyOutcome,
  validateRequestPolicyReview,
} from "../../network/protocol.ts";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

// message_parity.py は nas_addon を import し、nas_addon は ./vendor の
// graphql-core を必要とする。vendor/ は gitignore 済みの生成物なので、
// `bun run vendor` 未実行の checkout では ModuleNotFoundError で落ちる。
const vendoredDeps = existsSync(path.join(addonDir, "vendor", "graphql"));

const MASK_VALUES = ["s3cret-value"];

/** Claude Code が送る形に、その場で足したタグを混ぜたボディ。 */
function body(extraContent: unknown[]): string {
  return JSON.stringify({
    model: "claude-opus-4-20250514",
    max_tokens: 8192,
    system: [{ type: "text", text: "You are Claude Code." }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi s3cret-value" }, ...extraContent],
      },
    ],
  });
}

/** 既定 (同梱ポリシーの `anthropic.messages`) 以外で検査させるときの宛先。 */
interface InspectionTarget {
  readonly document: ResolvedDocument;
  readonly ruleId: string;
  readonly host: string;
  readonly path: string;
}

async function messagesFor(
  requestBody: string,
  target?: InspectionTarget,
): Promise<{
  result: string;
  reason: string;
  authorize: unknown;
  review: unknown;
  outcome: unknown;
}> {
  const proc = Bun.spawn(
    [
      python3 as string,
      "message_parity.py",
      requestBody,
      JSON.stringify(MASK_VALUES),
      ...(target === undefined ? [] : [JSON.stringify(target)]),
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
  if (exitCode !== 0) throw new Error(`message_parity.py failed: ${stderr}`);
  return JSON.parse(stdout);
}

test.skipIf(!python3 || !vendoredDeps)(
  "the broker accepts the authorization truth table the addon builds",
  async () => {
    const document = await shippedDocument();
    const { authorize } = await messagesFor(body([]));

    expect(validateAuthorizeRequest(authorize, "sess_parity", document)).toBe(
      null,
    );
    expect(authorize).toMatchObject({
      transport: "http",
      bodyTruth: { "anthropic.messages": "true" },
      reviewContext: {
        path: "/v1/messages",
        contentType: "application/json",
      },
    });
    expect(JSON.stringify(authorize)).not.toContain("bodyKind");
  },
);

async function shippedDocument(): Promise<ResolvedDocument> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../network/fixtures/authz/resolved-document.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ResolvedDocument;
}

test.skipIf(!python3 || !vendoredDeps)(
  "the broker accepts the review query the addon builds",
  async () => {
    const document = await shippedDocument();
    const { result, review } = await messagesFor(
      body([
        { type: "future_block", note: "s3cret-value" },
        { type: "another_future_block" },
        // 同じタグの 2 件目は件数に畳まれるので、違反レコードは 2 件になる。
        { type: "future_block" },
      ]),
    );

    expect(result).toEqual("review");
    expect(validateRequestPolicyReview(review, "sess_parity", document)).toBe(
      null,
    );
    const findings = (review as { findings: { value: string }[] }).findings;
    expect(findings.map((f) => f.value)).toEqual([
      "future_block",
      "another_future_block",
    ]);
    expect(JSON.stringify(review)).not.toContain("s3cret-value");
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "the broker accepts the outcome report the addon builds",
  async () => {
    const document = await shippedDocument();
    const { outcome } = await messagesFor(
      body([{ type: "future_block", note: "s3cret-value" }]),
    );

    expect(validateRequestPolicyOutcome(outcome, "sess_parity", document)).toBe(
      null,
    );
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "a value too long to keep whole still fits what the broker accepts",
  async () => {
    // 値はボディ由来なので、長さはリクエストが選ぶ。addon は畳んで digest を
    // 付けるが、その結果が broker の長さの天井を超えていたら、押せるはずの
    // 違反が丸ごと拒まれる。
    const document = await shippedDocument();
    const { review } = await messagesFor(body([{ type: "x".repeat(20_000) }]));

    expect(validateRequestPolicyReview(review, "sess_parity", document)).toBe(
      null,
    );
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "a body the policy accepts produces no violation to confirm",
  async () => {
    const { result, outcome } = await messagesFor(body([]));
    const document = await shippedDocument();

    expect(result).toEqual("rewrite");
    expect((outcome as { findings: unknown[] }).findings).toEqual([]);
    expect(validateRequestPolicyOutcome(outcome, "sess_parity", document)).toBe(
      null,
    );
  },
);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * ボディ条件 (`BodyExpect`) を 3 つ持つルール。1 つのボディが 3 種の違反レコードを
 * 同時に出す: 値条件の `schema-mismatch`、GraphQL の `schema-mismatch`
 * (正準形の値と、値が UUID になる解決不能な引数)、解析できない document の
 * `body-unavailable`。
 */
function bodyExpectTarget(): InspectionTarget {
  const outcome = resolveAuthzConfig({
    network: {
      scopes: {
        github: {
          targets: ["api.github.com"],
          rules: {
            graphql: {
              match: {
                methods: ["POST"],
                paths: ["/graphql"],
                body: { format: "json" },
              },
              onMatch: "allow",
              expect: [
                {
                  kind: "body",
                  equals: { "/tier": "gold" },
                  onViolation: "review",
                },
                {
                  kind: "body",
                  graphql: {
                    operations: ["query"],
                    fieldPaths: ["/repository/issues/nodes/body"],
                    fieldArguments: { "/repository": { owner: ["my-org"] } },
                  },
                  onViolation: "review",
                },
                {
                  kind: "body",
                  graphql: {
                    at: "/extra",
                    operations: ["query"],
                    fieldPaths: ["/viewer/login"],
                  },
                  onViolation: "review",
                },
              ],
            },
          },
        },
      },
    },
  });
  expect(outcome.diagnostics).toEqual([]);
  if (outcome.document === null) throw new Error("unresolvable config");
  return {
    // ホストが addon に書き出すのと同じ形。
    document: withoutInjectLiterals(outcome.document),
    ruleId: "github.graphql",
    host: "api.github.com",
    path: "/graphql",
  };
}

test.skipIf(!python3 || !vendoredDeps)(
  "the broker accepts the review and outcome that carry body findings",
  async () => {
    const target = bodyExpectTarget();
    const requestBody = JSON.stringify({
      tier: "bronze",
      query:
        "mutation($o: String!) { hidden_alias: deleteRepository(owner: $o) " +
        "repository(owner: $o) { id } }",
      extra: "query {",
    });
    const first = await messagesFor(requestBody, target);
    const second = await messagesFor(requestBody, target);

    expect(first.result).toEqual("review");
    expect(
      validateAuthorizeRequest(first.authorize, "sess_parity", target.document),
    ).toBe(null);
    expect(
      validateRequestPolicyReview(first.review, "sess_parity", target.document),
    ).toBe(null);
    expect(
      validateRequestPolicyOutcome(
        first.outcome,
        "sess_parity",
        target.document,
      ),
    ).toBe(null);

    const findingsOf = (message: unknown) =>
      (message as { findings: ViolationFinding[] }).findings;
    // 値が UUID の違反レコードは「何らかの UUID」として比べる。読める事実は label にある。
    const shown = (finding: ViolationFinding) => [
      finding.expect,
      finding.expectKind,
      finding.kind,
      finding.at,
      finding.value !== null && UUID.test(finding.value)
        ? "<uuid>"
        : finding.value,
      finding.label,
      finding.excerpt,
    ];
    const expected = [
      [0, "body", "schema-mismatch", "/tier", '/tier="bronze"', null, null],
      [
        1,
        "body",
        "schema-mismatch",
        "/query",
        "<uuid>",
        "operation:mutation",
        null,
      ],
      [
        1,
        "body",
        "schema-mismatch",
        "/query",
        "<uuid>",
        "fieldPath:/deleteRepository",
        null,
      ],
      [
        1,
        "body",
        "schema-mismatch",
        "/query",
        "<uuid>",
        "fieldPath:/repository/id",
        null,
      ],
      [
        1,
        "body",
        "schema-mismatch",
        "/query",
        "<uuid>",
        "fieldArgument:/repository@owner=(unresolved)",
        null,
      ],
      [
        2,
        "body",
        "body-unavailable",
        "/extra",
        "<uuid>",
        "document:(unanalysable)",
        null,
      ],
    ];
    expect(findingsOf(first.review).map(shown)).toEqual(expected);
    expect(findingsOf(first.outcome).map(shown)).toEqual(expected);

    // UUID はリクエストごとに作り直す。同じボディでも別のリクエストの承認には
    // ならない。
    const uuids = (message: unknown) =>
      findingsOf(message)
        .map((finding) => finding.value)
        .filter((value) => value !== null && UUID.test(value));
    expect(uuids(first.review)).toHaveLength(5);
    expect(new Set(uuids(first.review)).size).toBe(5);
    expect(uuids(second.review)).toHaveLength(5);
    for (const value of uuids(second.review)) {
      expect(uuids(first.review)).not.toContain(value);
    }
    // 違反した取得経路は label に載るが、document の本文そのもの・alias・
    // 引数の実値・parser の例外文は、どの電文にも載らない。
    for (const message of [
      first.authorize,
      first.review,
      first.outcome,
      second.authorize,
      second.review,
      second.outcome,
    ]) {
      const text = JSON.stringify(message);
      expect(text).not.toContain("hidden_alias");
      expect(text).not.toContain("mutation($o");
      expect(text).not.toContain("query {");
    }
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "the broker accepts the findings a URL query string leaves on GraphQL conditions",
  async () => {
    // サーバは document と変数を URL からも読むので、GraphQL の条件ごとに
    // 1 件、リクエスト限りの違反レコードになる。クエリ文字列は違反レコードに載らない。
    const target = {
      ...bodyExpectTarget(),
      path: "/graphql?query=mutation%7BdeleteRepository%7D",
    };
    const requestBody = JSON.stringify({
      tier: "gold",
      query: "{ viewer { id } }",
      extra: "{ viewer { id } }",
    });
    const messages = await messagesFor(requestBody, target);

    expect(messages.result).toEqual("review");
    expect(
      validateRequestPolicyReview(
        messages.review,
        "sess_parity",
        target.document,
      ),
    ).toBe(null);
    expect(
      validateRequestPolicyOutcome(
        messages.outcome,
        "sess_parity",
        target.document,
      ),
    ).toBe(null);
    const findings = (messages.review as { findings: ViolationFinding[] })
      .findings;
    expect(
      findings.map((finding) => [
        finding.expect,
        finding.kind,
        finding.at,
        finding.value !== null && UUID.test(finding.value),
        finding.label,
        finding.excerpt,
      ]),
    ).toEqual([
      [1, "body-unavailable", "/query", true, "document:(query-string)", null],
      [2, "body-unavailable", "/extra", true, "document:(query-string)", null],
    ]);
    expect(JSON.stringify(findings)).not.toContain("deleteRepository");
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "the broker accepts a finding whose value carries the longest pointer",
  async () => {
    // 違反レコードの値は Pointer を切らずに頭に付け、ボディ由来のスカラーだけを畳む。
    // 設定が許す最長の Pointer に、畳んだ後でも UTF-16 で最も長くなる
    // スカラー (サロゲートペアの文字だけの文字列) を並べても、broker の
    // 天井に収まること。
    const key = "p".repeat(MAX_BODY_EXPECT_POINTER_CHARS - 1);
    const outcome = resolveAuthzConfig({
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            rules: {
              body: {
                match: {
                  methods: ["POST"],
                  paths: ["/v1/body"],
                  body: { format: "json" },
                },
                onMatch: "allow",
                expect: [
                  {
                    kind: "body",
                    equals: { [`/${key}`]: "gold" },
                    onViolation: "review",
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(outcome.diagnostics).toEqual([]);
    if (outcome.document === null) throw new Error("unresolvable config");
    const target = {
      document: withoutInjectLiterals(outcome.document),
      ruleId: "api.body",
      host: "api.example.com",
      path: "/v1/body",
    };

    const { review } = await messagesFor(
      JSON.stringify({ [key]: "\u{1F600}".repeat(1000) }),
      target,
    );

    const [finding] = (review as { findings: ViolationFinding[] }).findings;
    expect(finding.value?.startsWith(`/${key}="\u{1F600}`)).toBe(true);
    // ボディ由来の部分だけに要る天井 (552) を超える長さである。
    expect(finding.value?.length).toBeGreaterThan(552);
    expect(
      validateRequestPolicyReview(review, "sess_parity", target.document),
    ).toBe(null);
  },
);
