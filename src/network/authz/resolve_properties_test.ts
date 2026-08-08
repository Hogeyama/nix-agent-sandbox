/**
 * 解決済みドキュメントの上での判定のプロパティテスト。
 *
 * 段階 0 の properties_test.ts と同じ立てつけである。依存を増やさないため
 * `fast-check` は使わず、seeded PRNG で生成器を手書きする。
 *
 * ここで守りたいのは 2 方向の誤りである。正当なリクエストが、それを許すはずの
 * スコープとルールに解決されないこと。許されないリクエストが、許す何かに解決
 * されてしまうこと。前者は使えない設定を生み、後者は認可の穴になる。実データ
 * では気づけないので、生成した設定と生成したリクエストの全組に対して検査する。
 */

import { describe, expect, test } from "bun:test";
import type { Action, AuthzConfig, RuleConfig, ScopeConfig } from "./config.ts";
import {
  anthropicExample,
  githubGraphqlExample,
  githubPathsExample,
} from "./examples_fixture.ts";
import { compiledPathMatches } from "./pattern.ts";
import type { CompiledMatch } from "./relation.ts";
import {
  decide,
  pathForSelection,
  type ResolvedDocument,
  type ResolvedRule,
  type ResolvedScope,
  resolveAuthzConfig,
} from "./resolve.ts";
import { evaluateMatch } from "./semantics.ts";
import { compareSpecificity, compareTargetSpecificity } from "./specificity.ts";
import type { AuthzRequest, RequestBody, TargetAddress } from "./types.ts";

// ------------------------------------------------------------------- 生成器

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function pickSome<T>(rng: Rng, items: readonly T[]): T[] {
  const chosen = items.filter(() => rng() < 0.5);
  return chosen.length === 0 ? [pick(rng, items)] : chosen;
}

const ACTIONS: readonly Action[] = ["allow", "review", "deny"];
const METHODS = ["GET", "POST"] as const;
/**
 * 入れ子になったパスだけを引く。
 *
 * 無作為なパターンの組はほとんどが「交差するが比較不能」になり、設定エラーで
 * 弾かれてドキュメントが 1 つも作られない。入れ子に寄せることで、選択の順序が
 * 実際に効く設定が生成される。
 */
const PATHS = [
  "/**",
  "/a/**",
  "/a/*",
  "/a/b",
  "/a/b/**",
  "/a/{n}",
  "/a/b/c",
] as const;
const CAPTURE_VALUES = ["b", "c"] as const;
const HOSTS = [
  "*.example.com",
  "api.example.com",
  "api.example.com:8443",
] as const;

function genRule(rng: Rng): RuleConfig {
  const paths = pickSome(rng, PATHS);
  const captures: Record<string, readonly string[]> = {};
  if (paths.some((path) => path.includes("{n}")) && rng() < 0.5) {
    captures.n = pickSome(rng, CAPTURE_VALUES);
  }
  return {
    match: {
      ...(rng() < 0.6 ? { methods: pickSome(rng, METHODS) } : {}),
      paths,
      captures,
      ...(rng() < 0.4
        ? { body: { format: pick(rng, ["none", "json", "opaque"] as const) } }
        : {}),
    },
    onMatch: pick(rng, ACTIONS),
    ...(rng() < 0.5
      ? { onIndeterminate: pick(rng, ["review", "deny"] as const) }
      : {}),
  };
}

function genScope(rng: Rng, hosts: readonly string[]): ScopeConfig {
  const rules: Record<string, RuleConfig> = {};
  const count = Math.floor(rng() * 4);
  for (let index = 0; index < count; index++) {
    rules[`r${index}`] = genRule(rng);
  }
  return {
    targets: [...hosts],
    fallback: pick(rng, ACTIONS),
    rules,
  };
}

/**
 * 評価順が観測できる形に寄せたルール。
 *
 * `genRule` は 1 本のルールに複数のパスを持たせるので、2 本のルールが「交差する
 * のに互いを包含しない」形になりやすく、その大半は設定エラーで消える。順序が
 * 効くのは残った側、すなわち包含も交差もしない組か、受理集合が等しい組である。
 * パスを 1 本に絞り、ボディ条件を高い確率で付けることで、その組が実際に出る。
 */
function genOrderedRule(rng: Rng): RuleConfig {
  return {
    match: {
      ...(rng() < 0.5 ? { methods: pickSome(rng, METHODS) } : {}),
      paths: [pick(rng, PATHS)],
      ...(rng() < 0.8
        ? { body: { format: pick(rng, ["none", "json", "opaque"] as const) } }
        : {}),
    },
    onMatch: pick(rng, ACTIONS),
    onIndeterminate: pick(rng, ["review", "deny"] as const),
  };
}

function genOrderedConfig(rng: Rng): AuthzConfig {
  const rules: Record<string, RuleConfig> = {};
  const count = 2 + Math.floor(rng() * 3);
  for (let index = 0; index < count; index++) {
    rules[`r${index}`] = genOrderedRule(rng);
  }
  return {
    network: {
      fallback: "deny",
      scopes: {
        api: { targets: ["api.example.com"], fallback: "deny", rules },
      },
    },
  };
}

function genConfig(rng: Rng): AuthzConfig {
  const scopes: Record<string, ScopeConfig> = {};
  const hosts = pickSome(rng, HOSTS);
  for (const [index, host] of hosts.entries()) {
    scopes[`s${index}`] = genScope(rng, [host]);
  }
  return {
    network: { fallback: pick(rng, ["review", "deny"] as const), scopes },
  };
}

// --------------------------------------------------------- リクエストの世界

const REQUEST_BODIES: readonly RequestBody[] = [
  { kind: "absent" },
  { kind: "empty" },
  { kind: "binary" },
  { kind: "json", value: { a: 1 } },
];

const REQUEST_PATHS = [
  "/",
  "/a",
  "/a/b",
  "/a/c",
  "/a/b/c",
  "/a/b/c/d",
  "/z",
] as const;

const ADDRESSES: readonly TargetAddress[] = [
  { host: "api.example.com", port: 443 },
  { host: "api.example.com", port: 8443 },
  { host: "cdn.example.com", port: 443 },
  { host: "example.com", port: 443 },
  { host: "other.test", port: 443 },
];

const REQUESTS: readonly AuthzRequest[] = (() => {
  const requests: AuthzRequest[] = [];
  for (const method of METHODS) {
    for (const path of REQUEST_PATHS) {
      for (const body of REQUEST_BODIES) requests.push({ method, path, body });
    }
  }
  return requests;
})();

// -------------------------------------------------------------------- 補助

function documentsFrom(seed: number, count: number): ResolvedDocument[] {
  return resolvableFrom(seed, count, genConfig).map(({ document }) => document);
}

/** 解決できた設定と、そのドキュメントの組。 */
interface Resolvable {
  readonly config: AuthzConfig;
  readonly document: ResolvedDocument;
}

function resolvableFrom(
  seed: number,
  count: number,
  generator: (rng: Rng) => AuthzConfig,
): Resolvable[] {
  const rng = makeRng(seed);
  const resolvable: Resolvable[] = [];
  for (let index = 0; index < count; index++) {
    const config = generator(rng);
    const outcome = resolveAuthzConfig(config);
    if (outcome.document !== null) {
      resolvable.push({ config, document: outcome.document });
    }
  }
  return resolvable;
}

/** そのルールの match がリクエストに対して返す 3 値。 */
function truthOf(rule: ResolvedRule, request: AuthzRequest) {
  return evaluateMatch(compiledOf(rule), request);
}

/** 解決済みの match を段階 0 の判定が読む形に戻す。 */
function compiledOf(rule: ResolvedRule): CompiledMatch {
  return {
    methods: rule.match.methods,
    paths: rule.match.paths,
    body: {
      format: rule.match.bodyFormat,
      pointers: new Map(),
      graphql: null,
    },
  };
}

function matchingScopes(
  document: ResolvedDocument,
  address: TargetAddress,
): readonly ResolvedScope[] {
  return document.scopes.filter((scope) =>
    scope.targets.some(
      (target) =>
        (target.host.kind === "exact"
          ? target.host.host === address.host
          : address.host.endsWith(`.${target.host.suffix}`)) &&
        (target.port === null || target.port === address.port),
    ),
  );
}

function context(
  document: ResolvedDocument,
  address: TargetAddress,
  request: AuthzRequest,
): string {
  return [
    `ターゲット: ${address.host}:${address.port}`,
    `リクエスト: ${request.method} ${request.path} ${JSON.stringify(request.body)}`,
    `ドキュメント: ${JSON.stringify(document.scopes.map((scope) => ({ name: scope.name, targets: scope.targets.map((t) => t.source), fallback: scope.fallback, rules: scope.rules.map((rule) => ({ id: rule.id, match: rule.match, onMatch: rule.onMatch })) })))}`,
  ].join("\n");
}

const DOCUMENT_COUNT = 300;

// ---------------------------------------------------------------- プロパティ

describe("解決済みドキュメントのプロパティ", () => {
  const documents = documentsFrom(11, DOCUMENT_COUNT);

  test("生成した設定のうち十分な数が解決できる", () => {
    // 前提が成り立たないと以降の検査が空回りする。
    expect(documents.length).toBeGreaterThan(30);
  });

  test("選ばれたスコープは、一致した他のすべてのスコープに包含される", () => {
    for (const document of documents) {
      for (const address of ADDRESSES) {
        const candidates = matchingScopes(document, address);
        const decision = decide(document, address, {
          method: "GET",
          path: "/a",
          body: { kind: "absent" },
        });
        if (candidates.length === 0) {
          expect(decision.scope).toBeNull();
          continue;
        }
        const chosen = decision.scope;
        if (chosen === null) {
          throw new Error(
            `一致するスコープがあるのに選ばれなかった\n${context(document, address, { method: "GET", path: "/a", body: { kind: "absent" } })}`,
          );
        }
        for (const other of candidates) {
          if (other === chosen) continue;
          // 設定エラーの検査を通ったので、一致するスコープは互いに包含関係に
          // ある。選ばれた側が真に狭くなければならない。
          if (
            compareTargetSpecificity(chosen.targets, other.targets) ===
            "narrower"
          ) {
            continue;
          }
          throw new Error(
            [
              `より特異でないスコープ ${chosen.name} が ${other.name} より先に選ばれた`,
              context(document, address, {
                method: "GET",
                path: "/a",
                body: { kind: "absent" },
              }),
            ].join("\n"),
          );
        }
      }
    }
  });

  test("allow になるのは allow を宣言したルールか fallback だけである", () => {
    for (const document of documents) {
      for (const address of ADDRESSES) {
        for (const request of REQUESTS) {
          const decision = decide(document, address, request);
          if (decision.action !== "allow") continue;
          const declared =
            decision.reason === "rule"
              ? decision.rule?.onMatch === "allow"
              : decision.reason === "scope-fallback"
                ? decision.scope?.fallback === "allow"
                : false;
          if (declared) continue;
          throw new Error(
            `誰も宣言していない allow が出た (${decision.reason})\n${context(document, address, request)}`,
          );
        }
      }
    }
  });

  test("判定不能から出る帰結は onIndeterminate に限られる", () => {
    let seen = 0;
    for (const document of documents) {
      for (const address of ADDRESSES) {
        for (const request of REQUESTS) {
          const decision = decide(document, address, request);
          if (decision.reason !== "indeterminate") continue;
          seen++;
          expect(decision.action).toBe(
            decision.rule?.onIndeterminate ?? "deny",
          );
          // 判定不能から allow は出ない。
          expect(decision.action).not.toBe("allow");
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  test("ルールが選ばれたなら、その match はリクエストを受理している", () => {
    let seen = 0;
    for (const document of documents) {
      for (const address of ADDRESSES) {
        for (const request of REQUESTS) {
          const decision = decide(document, address, request);
          const rule = decision.rule;
          if (rule === null) continue;
          seen++;
          const expected =
            decision.reason === "rule" ? "true" : "indeterminate";
          if (truthOf(rule, request) === expected) continue;
          throw new Error(
            `選ばれたルール ${rule.id} が ${expected} でない\n${context(document, address, request)}`,
          );
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  test("fallback に落ちたなら、そのスコープのどのルールも引き受けていない", () => {
    let seen = 0;
    for (const document of documents) {
      for (const address of ADDRESSES) {
        for (const request of REQUESTS) {
          const decision = decide(document, address, request);
          if (decision.reason !== "scope-fallback") continue;
          const scope = decision.scope;
          if (scope === null)
            throw new Error("scope-fallback にスコープがない");
          seen++;
          for (const rule of scope.rules) {
            if (truthOf(rule, request) === "false") continue;
            throw new Error(
              `引き受けたはずのルール ${rule.id} を飛ばして fallback に落ちた\n${context(document, address, request)}`,
            );
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  test("候補にならないルールは帰結に影響しない", () => {
    // メソッドかパスで外れたルールは、そのリクエストについて何も主張しない。
    // 主張しないルールが判定を動かせるなら、無関係なルールを 1 本足すだけで
    // deny が allow に化ける。ここは失敗が静かな緩みになる境界である。
    //
    // 順序が観測できる設定は普通の生成器ではめったに出ないので、そこへ寄せた
    // 生成器も併せて回す。
    const world = [
      ...resolvableFrom(11, DOCUMENT_COUNT, genConfig),
      ...resolvableFrom(13, DOCUMENT_COUNT, genOrderedConfig),
    ];
    let compared = 0;
    for (const { config, document } of world) {
      for (const request of REQUESTS) {
        const pruned = resolveAuthzConfig(
          withoutNonCandidates(config, document, request),
        ).document;
        if (pruned === null) continue;
        for (const address of ADDRESSES) {
          const before = decide(document, address, request);
          const after = decide(pruned, address, request);
          compared++;
          if (
            after.ruleId === before.ruleId &&
            after.action === before.action
          ) {
            continue;
          }
          throw new Error(
            [
              "候補でないルールを消しただけで帰結が変わった",
              `全部あり: ${before.ruleId} → ${before.action}`,
              `候補だけ: ${after.ruleId} → ${after.action}`,
              context(document, address, request),
            ].join("\n"),
          );
        }
      }
    }
    expect(compared).toBeGreaterThan(10_000);
  });

  test("選ばれたルールより特異で、かつ引き受けるルールは存在しない", () => {
    for (const document of documents) {
      for (const address of ADDRESSES) {
        for (const request of REQUESTS) {
          const decision = decide(document, address, request);
          const chosen = decision.rule;
          const scope = decision.scope;
          if (chosen === null || scope === null) continue;
          for (const other of scope.rules) {
            if (other === chosen) continue;
            if (truthOf(other, request) === "false") continue;
            if (!narrowerThan(other, chosen)) continue;
            throw new Error(
              `より特異な ${other.id} を飛ばして ${chosen.id} が選ばれた\n${context(document, address, request)}`,
            );
          }
        }
      }
    }
  });
});

/**
 * そのリクエストの候補にならないルールを設定から削って、解決からやり直す。
 *
 * 解決済みのドキュメントから削るのでは足りない。評価順を解決時に固定する実装は、
 * 並べ終えた後の列から要素を抜いても相対順序が変わらないので、削っても削らなくても
 * 同じ答えを返してしまう。順序が候補の集合から決まっているかを見るには、設定の
 * 段階で削って解決し直すしかない。
 *
 * 候補の定義は設計「評価順」の手順 2 から書き下ろす。判定側の実装を借りると、
 * 候補の集め方が壊れたときに検査も一緒に壊れて何も言わなくなる。
 */
function withoutNonCandidates(
  config: AuthzConfig,
  document: ResolvedDocument,
  request: AuthzRequest,
): AuthzConfig {
  const path = pathForSelection(request.path);
  const candidateKeys = new Map<string, ReadonlySet<string>>();
  for (const scope of document.scopes) {
    candidateKeys.set(
      scope.name,
      new Set(
        scope.rules
          .filter(
            (rule) =>
              (rule.match.methods === null ||
                rule.match.methods.includes(request.method)) &&
              rule.match.paths.some((pattern) =>
                compiledPathMatches(pattern, path),
              ),
          )
          .map((rule) => rule.key),
      ),
    );
  }

  const scopes: Record<string, ScopeConfig> = {};
  for (const [name, scope] of Object.entries(config.network.scopes)) {
    const keep = candidateKeys.get(name) ?? new Set<string>();
    const rules: Record<string, RuleConfig> = {};
    for (const [key, rule] of Object.entries(scope.rules ?? {})) {
      if (keep.has(key)) rules[key] = rule;
    }
    scopes[name] = { ...scope, rules };
  }
  return { ...config, network: { ...config.network, scopes } };
}

function narrowerThan(a: ResolvedRule, b: ResolvedRule): boolean {
  return compareSpecificity(compiledOf(a), compiledOf(b)) === "narrower";
}

describe("ドキュメントの受け渡し", () => {
  test("記述例のドキュメントは JSON を往復しても変わらない", () => {
    // proxy の addon へ渡すのが存在理由なので、Map や undefined を持てない。
    for (const config of [
      githubGraphqlExample(),
      githubPathsExample(),
      anthropicExample(),
    ]) {
      const document = resolveAuthzConfig(config).document;
      expect(document).not.toBeNull();
      expect(JSON.parse(JSON.stringify(document))).toEqual(
        document as unknown as object,
      );
    }
  });

  test("生成したドキュメントも JSON を往復しても変わらない", () => {
    for (const document of documentsFrom(12, 100)) {
      expect(JSON.parse(JSON.stringify(document))).toEqual(
        document as unknown as object,
      );
    }
  });
});
