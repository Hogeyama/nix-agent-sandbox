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
import * as path from "node:path";
import type { AuthzConfig } from "../../network/authz/config.ts";
import { normalizeBody } from "../../network/authz/relation.ts";
import {
  decide,
  type ResolvedDocument,
  type ResolvedRule,
  resolveAuthzConfig,
} from "../../network/authz/resolve.ts";
import { evaluateBody } from "../../network/authz/semantics.ts";
import type { JsonValue, RequestBody } from "../../network/authz/types.ts";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

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
  readonly body: BodyCase;
}

interface SerializedDecisionCase {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly path: string;
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
 */
const CONFIG: AuthzConfig = {
  network: {
    fallback: "review",
    scopes: {
      exact: {
        targets: ["api.example.com"],
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

function resolvedBodyMatch(rule: ResolvedRule) {
  return rule.match.bodyFormat === null
    ? undefined
    : {
        format: rule.match.bodyFormat,
        equals: rule.match.equals,
        oneOf: rule.match.oneOf,
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
  // Scope selection depends only on the target, so this exposes its effective
  // body budget without letting a provisional body decision affect it.
  const scope = decide(document, address, {
    method: case_.method,
    path: case_.path,
    body: { kind: "absent" },
  }).scope;
  const body = requestBody(
    case_.body,
    scope?.limits.maxBodyBytes ?? document.defaults.limits.maxBodyBytes,
  );
  const decision = decide(
    document,
    address,
    { method: case_.method, path: case_.path, body },
    (rule) =>
      evaluateBody(
        normalizeBody(resolvedBodyMatch(rule)),
        requestBody(case_.body, rule.limits.maxBodyBytes),
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
    bodyKind,
    decision.action,
    decision.reason,
    decision.ruleId,
  ].join("|");
}

test.skipIf(!python3)(
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

test.skipIf(!python3)(
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
