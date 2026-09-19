/**
 * `decide` (TypeScript) と `_decide` (Python) が同じ答えを出すこと。
 *
 * 認可の判定は 2 回行われる。ホスト側の broker が解決済みドキュメントの上で
 * 決め、addon が同じドキュメントの上で同じ選択を再現する。addon は両者が
 * 指したルールを突き合わせ、食い違ったら fail-closed で止める。
 *
 * その突き合わせがあるので、片方だけが正しい実装は「静かな緩み」ではなく
 * 「動かないセッション」になる。危ないのは両方が同じように間違うことなので、
 * ここでは 2 つの実装を同じ入力の直積に通して 1 件ずつ比べる。ドキュメントは
 * 手で書かず、設定を解決器に通して作る。
 */

import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { AuthzConfig } from "../../network/authz/config.ts";
import { buildGraphqlDocuments } from "../../network/authz/graphql.ts";
import { normalizeBody } from "../../network/authz/relation.ts";
import {
  decide,
  type ResolvedDocument,
  type ResolvedRule,
  resolveAuthzConfig,
  resolvedBodyMatch,
} from "../../network/authz/resolve.ts";
import { evaluateBody } from "../../network/authz/semantics.ts";
import type { JsonValue, RequestBody } from "../../network/authz/types.ts";
import type { RequestTransport } from "../../network/protocol.ts";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

// decide_parity.py は nas_addon を import し、nas_addon は ./vendor の
// graphql-core を必要とする。vendor/ は gitignore 済みの生成物なので、
// `bun run vendor` 未実行の checkout では ModuleNotFoundError で落ちる。
const vendoredDeps = existsSync(path.join(addonDir, "vendor", "graphql"));

interface BodyCase {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly carriesBody: boolean;
}

interface DecisionCase {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly transport?: RequestTransport;
  readonly body: BodyCase;
}

interface SerializedDecisionCase {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly transport: RequestTransport;
  readonly carriesBody: boolean;
  readonly bodyBase64: string;
}

/**
 * 選択の各軸を 1 つずつ突く設定。
 *
 * - スコープの入れ子 (`exact` ⊂ `wide`) と、ポートで閉じたスコープ
 * - `**` の末尾、capture の制約、メソッドの絞り込み
 * - `"json"` と `"none"` という、互いを包含せず交差もしない body 条件。
 *   この 2 本は特異度で決着しないので、順序は宣言順のタイブレークで決まり、
 *   判定不能での打ち切りによってその順序が観測できる。両実装が同じ順序を
 *   選んでいないと、空ボディの `/v1/ping` で答えが割れる。
 * - 宣言順と特異度順が**食い違う**候補 (`order` スコープ)。`exact` スコープの
 *   ルールは広いものが後ろに宣言してあるので、宣言順に評価しても特異度順に
 *   評価しても同じ列になる。それだけでは「候補を特異度で並べ替えている」ことを
 *   確かめられない — 並べ替えを消して宣言順で歩く実装も同じ答えを返す。
 *   `order` スコープは広いルールを先に宣言し、狭いルールを後に宣言するので、
 *   2 つの順序が別々の答えを出す。
 * - GraphQL 条件 (`graphql` スコープ)。document の解析はルールごとに、その
 *   ルール自身の `maxNodes` / `maxDepth` で行う。予算の違う 2 本 (`read` は
 *   `maxDepth` を、`mutations` は `maxNodes` を絞る) が同じ document を見るので、
 *   片方の予算で解析した結果をもう片方に使い回す実装はここで割れる。
 *   `read` と `mutations` は operations が互いに素で、特異度では決着しない。
 *   両方が判定不能になる document では、どちらで打ち切るか (review か deny か)
 *   が評価順を映す。
 */
const CONFIG: AuthzConfig = {
  network: {
    fallback: "review",
    scopes: {
      exact: {
        targets: ["api.example.com"],
        webSocket: "allow",
        fallback: "deny",
        rules: {
          "ping.none": {
            match: { paths: ["/v1/ping"], body: { format: "none" } },
            onMatch: "allow",
          },
          "ping.json": {
            match: { paths: ["/v1/ping"], body: { format: "json" } },
            onMatch: "review",
            onIndeterminate: "review",
          },
          repos: {
            match: {
              methods: ["GET"],
              paths: ["/repos/{org}/**"],
              captures: { org: ["my-org"] },
            },
            onMatch: "allow",
          },
          all: { match: { paths: ["/**"] }, onMatch: "deny" },
        },
      },
      wide: { targets: ["*.example.com"], fallback: "allow" },
      // ボディを持たないリクエストと、長さ 0 のボディを持つリクエストで帰結が
      // 割れる形。`"opaque"` はボディが存在することを条件にするので、ボディの
      // ない `absent` は受理せず、広い `deny` に落ちる。`empty` は受理して
      // `allow` になる。addon が両者を同じ種別に潰していれば、この 2 行が同じ
      // 答えになって食い違う。
      bodyless: {
        targets: ["bodyless.example"],
        fallback: "review",
        rules: {
          opaque: {
            match: { paths: ["/**"], body: { format: "opaque" } },
            onMatch: "allow",
          },
          all: { match: { paths: ["/**"] }, onMatch: "deny" },
        },
      },
      tls: { targets: ["other.example:8443"], fallback: "allow" },
      // 値条件は同じ入力を `equals` / `oneOf` の真・偽・判定不能それぞれに
      // 通すためだけの小さな scope。個別の意味論は resolve_test.ts が持ち、
      // ここでは同じ実バイト列に対する Python との選択結果を見る。
      values: {
        targets: ["values.example"],
        fallback: "deny",
        rules: {
          equals: {
            match: {
              paths: ["/v1/equals"],
              body: { format: "json", equals: { "/tier": "gold" } },
            },
            onMatch: "allow",
            onIndeterminate: "review",
          },
          oneof: {
            match: {
              paths: ["/v1/oneof"],
              body: {
                format: "json",
                oneOf: { "/tier": ["gold", "silver"] },
              },
            },
            onMatch: "review",
            onIndeterminate: "deny",
          },
          broad: { match: { paths: ["/**"] }, onMatch: "deny" },
        },
      },
      scopeBudget: {
        targets: ["scope-budget.example"],
        limits: { maxBodyBytes: 8 },
        rules: {
          json: {
            match: {
              paths: ["/v1/run"],
              body: { format: "json", equals: { "/tier": "gold" } },
            },
            onMatch: "allow",
            onIndeterminate: "review",
          },
        },
      },
      ruleBudget: {
        targets: ["rule-budget.example"],
        limits: { maxBodyBytes: 64 },
        rules: {
          json: {
            match: {
              paths: ["/v1/run"],
              body: { format: "json", equals: { "/tier": "gold" } },
            },
            onMatch: "allow",
            onIndeterminate: "review",
            limits: { maxBodyBytes: 8 },
          },
        },
      },
      graphql: {
        targets: ["graphql.example"],
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
                  rootFields: ["repository", "viewer"],
                  arguments: { owner: ["my-org"] },
                },
              },
            },
            onMatch: "allow",
            onIndeterminate: "review",
            limits: { maxDepth: 4 },
          },
          mutations: {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: { format: "json", graphql: { operations: ["mutation"] } },
            },
            onMatch: "review",
            onIndeterminate: "deny",
            // 普通の document (最長の GRAPHQL_READ で 31 token) は収まり、
            // 名前を 60 個並べた document だけが越える。
            limits: { maxNodes: 40 },
          },
          any: {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: { format: "json" },
            },
            onMatch: "deny",
          },
        },
      },
      // 宣言順は broad → ping → echo.opaque → echo.json、特異度順はその逆。
      // 宣言順に歩く実装は POST /v1/ping を broad の allow で答え、
      // /v1/echo をどのボディでも broad の allow で答えるので、正しい実装の
      // deny / indeterminate と食い違う。
      order: {
        targets: ["order.example"],
        fallback: "review",
        rules: {
          broad: { match: { paths: ["/**"] }, onMatch: "allow" },
          ping: {
            match: { methods: ["POST"], paths: ["/v1/ping"] },
            onMatch: "deny",
          },
          "echo.opaque": {
            match: { paths: ["/v1/echo"], body: { format: "opaque" } },
            onMatch: "review",
          },
          "echo.json": {
            match: { paths: ["/v1/echo"], body: { format: "json" } },
            onMatch: "allow",
          },
        },
      },
    },
  },
};

const HOSTS = [
  "api.example.com",
  "sub.example.com",
  "example.com",
  "other.example",
  "order.example",
  "bodyless.example",
  "nope.test",
];
const PORTS = [443, 8443];
const ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/v1/ping"],
  ["POST", "/v1/ping"],
  ["POST", "/v1/echo"],
  ["GET", "/repos/my-org/x"],
  ["GET", "/repos/other/x"],
  ["GET", "/a/b?q=1"],
];

function body(name: string, source: string, carriesBody: boolean): BodyCase {
  return { name, bytes: new TextEncoder().encode(source), carriesBody };
}

const NO_BODY = body("no-body", "", false);
const EMPTY_BODY = body("empty", "", true);
const OPAQUE_BODY = body("opaque-non-json", "not json", true);
const VALID_JSON_BODY = body("valid-json", '{"probe":true}', true);

const AXIS_BODIES: readonly BodyCase[] = [
  NO_BODY,
  EMPTY_BODY,
  OPAQUE_BODY,
  VALID_JSON_BODY,
];

const VALUE_CASES: readonly DecisionCase[] = [
  {
    name: "scope-budget-classifies-oversize-body-as-binary",
    host: "scope-budget.example",
    port: 443,
    method: "POST",
    path: "/v1/run",
    body: body("over-scope-budget", '{"tier":"gold"}', true),
  },
  {
    name: "rule-budget-downgrades-parsed-body-to-binary",
    host: "rule-budget.example",
    port: 443,
    method: "POST",
    path: "/v1/run",
    body: body("over-rule-budget", '{"tier":"gold"}', true),
  },
  {
    name: "malformed-json-stops-ping-json",
    host: "api.example.com",
    port: 443,
    method: "POST",
    path: "/v1/ping",
    body: body("malformed-json", '{"tier":', true),
  },
  {
    name: "scalar-json-has-no-tier",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body("scalar-json", "7", true),
  },
  {
    name: "equals-true",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body("structured-json", '{"tier":"gold"}', true),
  },
  {
    name: "equals-false",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body("structured-json", '{"tier":"bronze"}', true),
  },
  {
    name: "duplicate-json-members-are-unparseable",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body(
      "duplicate-json-members",
      '{"tier":"gold","tier":"bronze"}',
      true,
    ),
  },
  {
    name: "escaped-equivalent-json-members-are-unparseable",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body(
      "escaped-equivalent-json-members",
      '{"tier":"gold","t\\u0069er":"bronze"}',
      true,
    ),
  },
  {
    name: "integer-beyond-python-digit-limit-remains-json",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body(
      "integer-beyond-python-digit-limit",
      `{"tier":${"9".repeat(4_301)}}`,
      true,
    ),
  },
  {
    name: "equals-missing-pointer",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body("structured-json", "{}", true),
  },
  {
    name: "equals-non-scalar-target",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/equals",
    body: body("structured-json", '{"tier":{}}', true),
  },
  {
    name: "oneof-true",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/oneof",
    body: body("structured-json", '{"tier":"silver"}', true),
  },
  {
    name: "oneof-false",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/oneof",
    body: body("structured-json", '{"tier":"bronze"}', true),
  },
  {
    name: "oneof-missing-pointer",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/oneof",
    body: body("structured-json", "{}", true),
  },
  {
    name: "oneof-non-scalar-target",
    host: "values.example",
    port: 443,
    method: "POST",
    path: "/v1/oneof",
    body: body("structured-json", '{"tier":[]}', true),
  },
];

/**
 * `graphql` スコープに流す document。答えは次の 3 本のどれで終わるかで読む。
 * `read` の真は allow、判定不能は打ち切りの review。`mutations` の真は
 * review、判定不能は打ち切りの deny。どちらも偽なら `any` の deny (rule)。
 */
function graphqlCase(
  name: string,
  requestBody: unknown,
  requestPath = "/graphql",
): DecisionCase {
  return {
    name: `graphql-${name}`,
    host: "graphql.example",
    port: 443,
    method: "POST",
    path: requestPath,
    body: body(
      name,
      typeof requestBody === "string"
        ? requestBody
        : JSON.stringify(requestBody),
      true,
    ),
  };
}

const GRAPHQL_READ =
  'query($o: String!) { repository(owner: $o, name: "x") { issues(first: 10) { totalCount } } }';

const GRAPHQL_DEFAULT =
  'query($o: String = "my-org") { repository(owner: $o, name: "x") { id } }';

const MANY_FIELDS = Array.from({ length: 60 }, (_, i) => `f${i}`).join(" ");

const GRAPHQL_CASES: readonly DecisionCase[] = [
  graphqlCase("shorthand", { query: "{ viewer { login } }" }),
  graphqlCase("mutation", {
    query: 'mutation { addStar(owner: "my-org") { id } }',
  }),
  // root の fragment spread を展開しないと rootFields が空になり、node が
  // rootFields の制約をすり抜ける。
  graphqlCase("root-fragment-spread", {
    query: 'query { ...f } fragment f on Query { node(id: "1") { id } }',
  }),
  graphqlCase("root-inline-fragment", {
    query: '{ ... on Query { node(id: "1") { id } } }',
  }),
  graphqlCase("variable-resolved", {
    query: GRAPHQL_READ,
    variables: { o: "my-org" },
  }),
  graphqlCase("variable-resolved-other", {
    query: GRAPHQL_READ,
    variables: { o: "other-org" },
  }),
  graphqlCase("literal-other", {
    query: 'query { repository(owner: "other-org", name: "x") { id } }',
  }),
  // 名指しした引数 (owner) が解決できない。read は判定不能で打ち切る。
  graphqlCase("named-argument-unresolved", { query: GRAPHQL_READ }),
  graphqlCase("named-argument-non-string", {
    query: GRAPHQL_READ,
    variables: { o: 7 },
  }),
  // variables に無い変数は operation の既定値で解決する。与えた値
  // (明示の null を含む) は既定値より優先する。
  graphqlCase("variable-default", { query: GRAPHQL_DEFAULT }),
  graphqlCase("variable-default-overridden", {
    query: GRAPHQL_DEFAULT,
    variables: { o: "other-org" },
  }),
  graphqlCase("variable-default-null", {
    query: GRAPHQL_DEFAULT,
    variables: { o: null },
  }),
  // variables が JSON の null なら無いのと同じく既定値で解決する。
  // オブジェクトでない variables (JSON を詰めた文字列など) は、サーバが
  // 読み直して使うことがあるので既定値に落とさず解決不能とする。
  graphqlCase("variables-null", { query: GRAPHQL_DEFAULT, variables: null }),
  graphqlCase("variables-string", {
    query: GRAPHQL_DEFAULT,
    variables: '{"o":"other-org"}',
  }),
  graphqlCase("variables-array", { query: GRAPHQL_DEFAULT, variables: [] }),
  graphqlCase("variables-number", { query: GRAPHQL_DEFAULT, variables: 1 }),
  graphqlCase("variables-boolean", {
    query: GRAPHQL_DEFAULT,
    variables: true,
  }),
  // 共有 fragment の引数は到達する operation ごとの既定値で評価する。
  graphqlCase("variable-default-shared-fragment", {
    query:
      'query A($o: String = "my-org") { ...f } ' +
      'query B($o: String = "other-org") { ...f } ' +
      'fragment f on Query { repository(owner: $o, name: "x") { id } }',
  }),
  // 名指ししない引数 (first: 10 の Int) の解決不能は判定に関与しない。
  graphqlCase("unnamed-argument-unresolved", {
    query:
      'query { repository(owner: "my-org", name: "x") { issues(first: 10) { totalCount } } }',
  }),
  // read の maxDepth (4) を越える。mutations は既定の深さで解析して偽。
  graphqlCase("query-over-read-depth", {
    query: "{ viewer { a { b { c { d } } } } }",
  }),
  graphqlCase("query-at-read-depth", {
    query: "{ viewer { a { b { c } } } }",
  }),
  // mutations だけが真になる document を、read の深さを越えて置く。
  // 両ルールの評価順で答えが割れる。
  graphqlCase("mutation-over-read-depth", {
    query: "mutation { a { b { c { d { e } } } } }",
  }),
  // mutations の maxNodes (40 token) を越える mutation。read は既定の予算で
  // 解析して偽なので、判定不能は mutations 自身の予算からしか来ない。
  graphqlCase("mutation-over-mutations-tokens", {
    query: `mutation { ${MANY_FIELDS} }`,
  }),
  graphqlCase("query-over-mutations-tokens", {
    query: `{ viewer { ${MANY_FIELDS} } }`,
  }),
  // `at` の対象が無いと偽 (any の deny)。文字列でなければ判定不能。
  graphqlCase("at-missing", { variables: {} }),
  graphqlCase("at-not-string", { query: 7 }),
  graphqlCase("unparseable", { query: "query {" }),
  graphqlCase("fragment-only", {
    query: "fragment f on Query { viewer { login } }",
  }),
  graphqlCase("not-json", "query { viewer { login } }"),
  // サーバは document と変数を URL からも読む。クエリ文字列があれば graphql
  // 条件はボディを見る前に判定不能になり、read で打ち切る。ボディに document
  // が無くても偽にはならない。`?` だけで中身が無ければ関係しない。
  graphqlCase(
    "query-string-document",
    { query: "{ viewer { login } }" },
    "/graphql?query=mutation%7BdeleteRepository%7D",
  ),
  graphqlCase(
    "query-string-variables",
    { query: GRAPHQL_DEFAULT },
    "/graphql?variables=%7B%22o%22%3A%22other-org%22%7D",
  ),
  graphqlCase(
    "query-string-nested-variables",
    { query: GRAPHQL_DEFAULT },
    "/graphql?variables[o]=other-org",
  ),
  graphqlCase(
    "query-string-no-document",
    { variables: {} },
    "/graphql?query=mutation%7BdeleteRepository%7D",
  ),
  graphqlCase(
    "query-string-empty",
    { query: "{ viewer { login } }" },
    "/graphql?",
  ),
];

function requestBody(
  bodyCase: BodyCase,
  maxBodyBytes = Number.POSITIVE_INFINITY,
): RequestBody {
  if (bodyCase.bytes.byteLength === 0) {
    return bodyCase.carriesBody ? { kind: "empty" } : { kind: "absent" };
  }
  if (bodyCase.bytes.byteLength > maxBodyBytes) return { kind: "binary" };
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      bodyCase.bytes,
    );
    rejectDuplicateJsonMembers(source);
    return { kind: "json", value: JSON.parse(source) as JsonValue };
  } catch {
    return { kind: "binary" };
  }
}

/**
 * そのルールが見るボディ。バイト数の予算で組み直し、GraphQL の document は
 * そのルール自身の `maxNodes` / `maxDepth` で解析する。addon が候補ごとに
 * 自分の limits で評価するのと同じ位置である。
 */
function ruleRequestBody(bodyCase: BodyCase, rule: ResolvedRule): RequestBody {
  const body = requestBody(bodyCase, rule.limits.maxBodyBytes);
  const graphql = rule.match.graphql;
  if (body.kind !== "json" || graphql === null) return body;
  return {
    ...body,
    documents: buildGraphqlDocuments(body.value, [graphql.at], rule.limits),
  };
}

function decideCase(
  document: ResolvedDocument,
  case_: DecisionCase,
): {
  readonly body: RequestBody;
  readonly decision: ReturnType<typeof decide>;
} {
  const address = { host: case_.host, port: case_.port };
  const transport = case_.transport ?? "http";
  // Scope selection depends only on the target, so this exposes its effective
  // body budget without letting a provisional body decision affect it.
  const scope = decide(document, address, {
    method: case_.method,
    path: case_.path,
    transport,
    body: { kind: "absent" },
  }).scope;
  const body = requestBody(
    case_.body,
    scope?.limits.maxBodyBytes ?? document.defaults.limits.maxBodyBytes,
  );
  const decision = decide(
    document,
    address,
    { method: case_.method, path: case_.path, transport, body },
    (rule) =>
      evaluateBody(
        normalizeBody(resolvedBodyMatch(rule.match)),
        ruleRequestBody(case_.body, rule),
        case_.path,
      ),
  );
  return { body, decision };
}

/** Mirror the addon's `object_pairs_hook=_reject_duplicate_members`. */
function rejectDuplicateJsonMembers(source: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (/[\t\n\r ]/.test(source[index] ?? "")) index++;
  };
  const requireCharacter = (character: string): void => {
    if (source[index] !== character) throw new Error(`expected ${character}`);
    index++;
  };
  const scanString = (): string => {
    const start = index;
    requireCharacter('"');
    while (index < source.length) {
      const character = source[index++];
      if (character === '"') {
        return JSON.parse(source.slice(start, index)) as string;
      }
      if (character === "\\") {
        if (source[index] === "u") index += 5;
        else index++;
      }
    }
    throw new Error("unterminated JSON string");
  };
  const scanValue = (): void => {
    skipWhitespace();
    switch (source[index]) {
      case "{":
        scanObject();
        return;
      case "[":
        scanArray();
        return;
      case '"':
        scanString();
        return;
      default: {
        const start = index;
        while (
          index < source.length &&
          !/[\t\n\r ,\]}]/.test(source[index] ?? "")
        ) {
          index++;
        }
        if (start === index) throw new Error("expected JSON value");
      }
    }
  };
  const scanObject = (): void => {
    requireCharacter("{");
    skipWhitespace();
    if (source[index] === "}") {
      index++;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      skipWhitespace();
      const key = scanString();
      if (keys.has(key)) throw new Error("duplicate JSON object member");
      keys.add(key);
      skipWhitespace();
      requireCharacter(":");
      scanValue();
      skipWhitespace();
      if (source[index] === "}") {
        index++;
        return;
      }
      requireCharacter(",");
    }
  };
  const scanArray = (): void => {
    requireCharacter("[");
    skipWhitespace();
    if (source[index] === "]") {
      index++;
      return;
    }
    while (true) {
      scanValue();
      skipWhitespace();
      if (source[index] === "]") {
        index++;
        return;
      }
      requireCharacter(",");
    }
  };

  scanValue();
  skipWhitespace();
  if (index !== source.length) throw new Error("trailing JSON input");
}

function serializeCase(case_: DecisionCase): SerializedDecisionCase {
  return {
    name: case_.name,
    host: case_.host,
    port: case_.port,
    method: case_.method,
    path: case_.path,
    transport: case_.transport ?? "http",
    carriesBody: case_.body.carriesBody,
    bodyBase64: Buffer.from(case_.body.bytes).toString("base64"),
  };
}

function decisionLine(
  case_: DecisionCase,
  bodyKind: RequestBody["kind"],
  decision: ReturnType<typeof decide>,
): string {
  return [
    case_.name,
    case_.host,
    String(case_.port),
    case_.method,
    case_.path,
    case_.transport ?? "http",
    bodyKind,
    decision.action,
    decision.reason,
    decision.ruleId,
  ].join("|");
}

test.skipIf(!python3 || !vendoredDeps)(
  "the addon reproduces the resolver's decision on every axis of selection",
  async () => {
    const resolved = resolveAuthzConfig(CONFIG);
    expect(resolved.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    const document = resolved.document;
    if (document === null) throw new Error("unresolvable fixture config");

    const cases: DecisionCase[] = [];
    for (const host of HOSTS) {
      for (const port of PORTS) {
        for (const [method, requestPath] of ROUTES) {
          for (const body of AXIS_BODIES) {
            cases.push({
              name: `${host}:${port} ${method} ${requestPath} ${body.name}`,
              host,
              port,
              method,
              path: requestPath,
              body,
            });
          }
        }
      }
    }
    cases.push(...VALUE_CASES);
    cases.push(...GRAPHQL_CASES);
    cases.push(
      {
        name: "websocket-allow-scope-reaches-review-rule",
        host: "api.example.com",
        port: 443,
        method: "POST",
        path: "/v1/ping",
        transport: "websocket",
        body: VALID_JSON_BODY,
      },
      {
        name: "websocket-default-denied-scope-closes-before-fallback",
        host: "sub.example.com",
        port: 443,
        method: "GET",
        path: "/ws",
        transport: "websocket",
        body: NO_BODY,
      },
      {
        name: "websocket-unscoped-closes-before-network-fallback",
        host: "nope.test",
        port: 443,
        method: "GET",
        path: "/ws",
        transport: "websocket",
        body: NO_BODY,
      },
    );

    const expected = cases.map((case_) => {
      const { body: classifiedBody, decision } = decideCase(document, case_);
      return decisionLine(case_, classifiedBody.kind, decision);
    });

    const proc = Bun.spawn(
      [
        python3 as string,
        "decide_parity.py",
        JSON.stringify(document),
        JSON.stringify(cases.map(serializeCase)),
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
    expect(stderr).toEqual("");
    expect(exitCode).toEqual(0);

    expect(stdout.trimEnd().split("\n")).toEqual(expected);
  },
);

test.skipIf(!python3 || !vendoredDeps)(
  "overflowing JSON numbers have the same candidate truth on host and addon",
  async () => {
    const resolved = resolveAuthzConfig({
      network: {
        scopes: {
          overflow: {
            targets: ["overflow.example"],
            rules: {
              broad: { match: { paths: ["/**"] }, onMatch: "allow" },
              narrow: {
                match: {
                  paths: ["/v1/run"],
                  body: { format: "json", equals: { "/n": 1 } },
                },
                onMatch: "deny",
                onIndeterminate: "deny",
              },
            },
          },
        },
      },
    });
    const document = resolved.document;
    if (document === null) throw new Error("unresolvable overflow config");

    const case_: DecisionCase = {
      name: "overflowing-json-number",
      host: "overflow.example",
      port: 443,
      method: "POST",
      path: "/v1/run",
      body: body("overflowing-number", '{"n":1e400}', true),
    };
    const { body: classifiedBody, decision } = decideCase(document, case_);
    const expected = decisionLine(case_, classifiedBody.kind, decision);

    const proc = Bun.spawn(
      [
        python3 as string,
        "decide_parity.py",
        JSON.stringify(document),
        JSON.stringify([serializeCase(case_)]),
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
    expect(stderr).toEqual("");
    expect(exitCode).toEqual(0);
    expect(stdout.trim()).toEqual(expected);
  },
);

/**
 * 突き合わせは TS と Python が同じように間違っても通る (例えば graphql 条件が
 * すべて偽に倒れ、全件が `any` に落ちる)。そこで代表的な document については
 * 仕様が決める答えをここで固定する。Python 側は上の突き合わせがこの答えに
 * 縛る。
 */
test("GraphQL documents select the rule the spec says they select", () => {
  const resolved = resolveAuthzConfig(CONFIG);
  const document = resolved.document;
  if (document === null) throw new Error("unresolvable fixture config");
  const byName = new Map(GRAPHQL_CASES.map((case_) => [case_.name, case_]));
  const decided = (name: string) => {
    const case_ = byName.get(`graphql-${name}`);
    if (case_ === undefined) throw new Error(`missing case ${name}`);
    const { decision } = decideCase(document, case_);
    return [decision.ruleId, decision.action, decision.reason];
  };

  // 条件をすべて満たす query は read が許す。省略形は query である。
  expect(decided("shorthand")).toEqual(["graphql.read", "allow", "rule"]);
  // 変数で渡した owner は variables を引いて解決する。
  expect(decided("variable-resolved")).toEqual([
    "graphql.read",
    "allow",
    "rule",
  ]);
  // variables に無い owner は operation の既定値で解決し、read が許す。
  expect(decided("variable-default")).toEqual([
    "graphql.read",
    "allow",
    "rule",
  ]);
  // 明示の null は既定値に落ちず解決不能で、read で打ち切る。
  expect(decided("variable-default-null")).toEqual([
    "graphql.read",
    "review",
    "indeterminate",
  ]);
  // variables が null なら既定値で解決し、read が許す。
  expect(decided("variables-null")).toEqual(["graphql.read", "allow", "rule"]);
  // オブジェクトでない variables の下では既定値に落ちず、read で打ち切る。
  for (const shape of ["string", "array", "number", "boolean"]) {
    expect(decided(`variables-${shape}`)).toEqual([
      "graphql.read",
      "review",
      "indeterminate",
    ]);
  }
  // mutation は read にとって偽で、mutations が選ぶ。
  expect(decided("mutation")).toEqual(["graphql.mutations", "review", "rule"]);
  // root の fragment spread は展開され、node が rootFields に無いので偽。
  expect(decided("root-fragment-spread")).toEqual([
    "graphql.any",
    "deny",
    "rule",
  ]);
  // 名指しした引数が解決できなければ判定不能で、read で打ち切る。
  expect(decided("named-argument-unresolved")).toEqual([
    "graphql.read",
    "review",
    "indeterminate",
  ]);
  // read 自身の maxDepth を越える document は判定不能。
  expect(decided("query-over-read-depth")).toEqual([
    "graphql.read",
    "review",
    "indeterminate",
  ]);
  // mutations 自身の maxNodes を越える mutation は、そのルールで判定不能。
  expect(decided("mutation-over-mutations-tokens")).toEqual([
    "graphql.mutations",
    "deny",
    "indeterminate",
  ]);
  // 同じ長さの query は read の既定の予算で解析され、許される。
  expect(decided("query-over-mutations-tokens")).toEqual([
    "graphql.read",
    "allow",
    "rule",
  ]);
  // `at` の対象が無いのは偽で、判定不能ではない。
  expect(decided("at-missing")).toEqual(["graphql.any", "deny", "rule"]);
  // クエリ文字列があれば、ボディの document が読み取りでも、既定値で解決
  // できても、document が無くても判定不能で、read で打ち切って人に回す。
  // `?query=mutation...` を読み取りのボディで包んでも許可にはならない。
  for (const name of [
    "query-string-document",
    "query-string-variables",
    "query-string-nested-variables",
    "query-string-no-document",
  ]) {
    expect([name, ...decided(name)]).toEqual([
      name,
      "graphql.read",
      "review",
      "indeterminate",
    ]);
  }
  expect(decided("query-string-empty")).toEqual([
    "graphql.read",
    "allow",
    "rule",
  ]);
});
