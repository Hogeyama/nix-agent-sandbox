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
import * as path from "node:path";
import type { AuthzConfig } from "../../network/authz/config.ts";
import { decide, resolveAuthzConfig } from "../../network/authz/resolve.ts";
import type { RequestBody } from "../../network/authz/types.ts";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

type BodyKind = "absent" | "empty" | "binary" | "json";

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
const BODY_KINDS: readonly BodyKind[] = ["absent", "empty", "binary", "json"];

function requestBody(kind: BodyKind): RequestBody {
  return kind === "json" ? { kind: "json", value: {} } : { kind };
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

    const cases: [string, number, string, string, BodyKind][] = [];
    for (const host of HOSTS) {
      for (const port of PORTS) {
        for (const [method, requestPath] of ROUTES) {
          for (const kind of BODY_KINDS) {
            cases.push([host, port, method, requestPath, kind]);
          }
        }
      }
    }

    const expected = cases.map(([host, port, method, requestPath, kind]) => {
      const decision = decide(
        document,
        { host, port },
        { method, path: requestPath, body: requestBody(kind) },
      );
      return [
        host,
        String(port),
        method,
        requestPath,
        kind,
        decision.action,
        decision.reason,
        decision.ruleId,
      ].join("|");
    });

    const proc = Bun.spawn(
      [
        python3 as string,
        "decide_parity.py",
        JSON.stringify(document),
        JSON.stringify(cases),
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

    const bodyJson = '{"n":1e400}';
    const decision = decide(
      document,
      { host: "overflow.example", port: 443 },
      {
        method: "POST",
        path: "/v1/run",
        body: { kind: "json", value: JSON.parse(bodyJson) },
      },
    );
    const expected = [
      "overflow.example",
      "443",
      "POST",
      "/v1/run",
      "json",
      decision.action,
      decision.reason,
      decision.ruleId,
    ].join("|");

    const proc = Bun.spawn(
      [
        python3 as string,
        "decide_parity.py",
        JSON.stringify(document),
        JSON.stringify([
          ["overflow.example", 443, "POST", "/v1/run", "json", bodyJson],
        ]),
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
