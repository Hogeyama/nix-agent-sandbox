/**
 * 解決済みドキュメントの生成と、その上での判定。
 *
 * 設計「評価順」「秘密の適用範囲」「注入 (Inject)」「予算」「監査」に対応する。
 * 設定を 1 度だけ解決し、継承 (既定 → スコープ → ルール) を畳み、候補の評価順を
 * 確定させた形にする。セッション中はこのドキュメントが変わらない。
 *
 * ドキュメントは JSON にできる値だけで構成する。Map や関数を持たせない。
 * proxy の addon へそのまま渡せることが、この形の存在理由だからである。
 *
 * `decide` は同じドキュメントの上でホスト側が使える参照実装である。addon の
 * 照合はこの関数と同じ順序・同じ打ち切りに従わなければならない。
 */

import {
  type Action,
  type AuditMode,
  type AuthzConfig,
  DEFAULT_AUDIT_MODE,
  DEFAULT_SECRET_DISPOSITIONS,
  type Expect,
  FALLBACK_RULE_KEY,
  type IndeterminateAction,
  type Inject,
  LIMIT_CEILINGS,
  LIMIT_KEYS,
  type Limits,
  type NetworkFallback,
  parseInjectValue,
  type ResolvedLimits,
  type SecretDisposition,
  type ViolationAction,
} from "./config.ts";
import { type CompiledPath, compiledPathMatches } from "./pattern.ts";
import { type CompiledMatch, hostMatches } from "./relation.ts";
import { evaluateBody } from "./semantics.ts";
import { compareTargetSpecificity, precedenceOrder } from "./specificity.ts";
import type {
  AuthzRequest,
  BodyFormat,
  Result,
  Target,
  TargetAddress,
} from "./types.ts";
import {
  type CompiledRule,
  type CompiledScope,
  compileAuthzConfig,
  type Diagnostic,
  effectiveInject,
  rulePrecedes,
} from "./validate.ts";

/** 解決後は `onViolation` が必ず決まっている。省略時は `deny`。 */
export type ResolvedExpect = Expect & { readonly onViolation: ViolationAction };

export interface ResolvedMatch {
  /** null は全メソッド。 */
  readonly methods: readonly string[] | null;
  readonly paths: readonly CompiledPath[];
  /** null はボディ条件を持たない。 */
  readonly bodyFormat: BodyFormat | null;
}

export interface ResolvedRule {
  /** 実 ID。`<スコープ名>.<キー>`。 */
  readonly id: string;
  readonly key: string;
  /**
   * このルールより後に評価する同一スコープのルールのキー。
   *
   * 特異度と `overrides` から解決時に畳んだ優先関係である。順序そのものではなく
   * 関係を持たせるのは、評価順が「そのリクエストの候補」の中でしか決まらない
   * ためである。候補になれないルールを含めて並べてしまうと、そのルールを足し
   * 引きするだけで候補どうしの宣言順のタイブレークが動く。
   */
  readonly precedes: readonly string[];
  readonly match: ResolvedMatch;
  readonly onMatch: Action;
  readonly onIndeterminate: IndeterminateAction;
  readonly expect: readonly ResolvedExpect[];
  readonly limits: ResolvedLimits;
  readonly secrets: Readonly<Record<string, SecretDisposition>>;
  readonly inject: readonly Inject[];
  readonly audit: AuditMode;
}

export interface ResolvedScope {
  readonly name: string;
  readonly targets: readonly Target[];
  readonly fallback: Action;
  /** `fallback` から生じた確認の擬似ルール ID。 */
  readonly fallbackRuleId: string;
  readonly limits: ResolvedLimits;
  readonly secrets: Readonly<Record<string, SecretDisposition>>;
  readonly inject: readonly Inject[];
  readonly audit: AuditMode;
  /**
   * スコープの `rules` Mapping における宣言順のルール。
   *
   * 評価順ではない。評価順はリクエストごとに、その候補の中で `precedes` と
   * この並びから決まる。
   */
  readonly rules: readonly ResolvedRule[];
}

export interface ResolvedDefaults {
  readonly limits: ResolvedLimits;
  readonly secrets: Readonly<Record<string, SecretDisposition>>;
  readonly audit: AuditMode;
}

export interface ResolvedDocument {
  readonly contractVersion: 2;
  /** どのスコープにも属さないターゲットの帰結。 */
  readonly fallback: NetworkFallback;
  readonly defaults: ResolvedDefaults;
  /** ターゲットの特異度の降順。同順は宣言順。 */
  readonly scopes: readonly ResolvedScope[];
}

export interface ResolveOutcome {
  /** 設定エラーがあれば null。警告だけならドキュメントを作る。 */
  readonly document: ResolvedDocument | null;
  readonly diagnostics: readonly Diagnostic[];
}

export function resolveAuthzConfig(config: AuthzConfig): ResolveOutcome {
  const { scopes, diagnostics } = compileAuthzConfig(config);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { document: null, diagnostics };
  }

  const configDefaults = config.network.defaults ?? {};
  const defaults: ResolvedDefaults = {
    limits: mergeLimits(LIMIT_CEILINGS, configDefaults.limits),
    secrets: { ...DEFAULT_SECRET_DISPOSITIONS, ...configDefaults.secrets },
    audit: configDefaults.audit ?? DEFAULT_AUDIT_MODE,
  };

  // 順序を作れない設定はドキュメントを作らない。設定エラーの検査が閉路を先に
  // 弾くので、ここに落ちるのは検査が取りこぼした形だけである。取りこぼしたときに
  // 適当な順序で進めば、それは静かな緩みになる。進まずに止める。
  const faults: Diagnostic[] = [];
  const resolved: ResolvedScope[] = [];
  for (const scope of scopes) {
    const outcome = resolveScope(scope, defaults);
    if (outcome.ok) resolved.push(outcome.value);
    else faults.push({ severity: "error", message: outcome.error });
  }
  if (faults.length > 0) {
    return { document: null, diagnostics: [...diagnostics, ...faults] };
  }

  const ordered = orderScopes(resolved);
  if (!ordered.ok) {
    return {
      document: null,
      diagnostics: [
        ...diagnostics,
        { severity: "error", message: ordered.error },
      ],
    };
  }

  return {
    document: {
      contractVersion: 2,
      fallback: config.network.fallback ?? "deny",
      defaults,
      scopes: ordered.value,
    },
    diagnostics,
  };
}

function resolveScope(
  scope: CompiledScope,
  defaults: ResolvedDefaults,
): Result<ResolvedScope> {
  const limits = mergeLimits(defaults.limits, scope.config.limits);
  const secrets = Object.fromEntries(scope.dispositions);
  const audit = scope.config.audit ?? defaults.audit;
  const inject = scope.config.inject ?? [];

  const edges = precedenceEdges(scope.rules);
  const rules = scope.rules.map((rule, index) =>
    resolveRule(rule, edges[index] as readonly string[], {
      limits,
      secrets,
      audit,
      inject,
    }),
  );

  const cycle = precedenceCycle(scope.name, rules);
  if (cycle !== null) return { ok: false, error: cycle };

  return {
    ok: true,
    value: {
      name: scope.name,
      targets: scope.targets,
      fallback: scope.config.fallback ?? "deny",
      fallbackRuleId: `${scope.name}.${FALLBACK_RULE_KEY}`,
      limits,
      secrets,
      inject,
      audit,
      rules,
    },
  };
}

interface ScopeInheritance {
  readonly limits: ResolvedLimits;
  readonly secrets: Readonly<Record<string, SecretDisposition>>;
  readonly audit: AuditMode;
  readonly inject: readonly Inject[];
}

function resolveRule(
  rule: CompiledRule,
  precedes: readonly string[],
  inherited: ScopeInheritance,
): ResolvedRule {
  return {
    id: rule.id,
    key: rule.key,
    precedes,
    match: toResolvedMatch(rule.match),
    onMatch: rule.config.onMatch,
    onIndeterminate: rule.config.onIndeterminate ?? "deny",
    expect: (rule.config.expect ?? []).map((expect) => ({
      ...expect,
      onViolation: expect.onViolation ?? "deny",
    })),
    limits: mergeLimits(inherited.limits, rule.config.limits),
    secrets: { ...inherited.secrets, ...rule.config.secrets },
    inject: effectiveInject(inherited.inject, rule.config.inject),
    audit: rule.config.audit ?? inherited.audit,
  };
}

function toResolvedMatch(match: CompiledMatch): ResolvedMatch {
  return {
    methods: match.methods,
    paths: match.paths,
    bodyFormat: match.body.format,
  };
}

function mergeLimits(
  base: ResolvedLimits,
  overlay: Limits | undefined,
): ResolvedLimits {
  if (overlay === undefined) return base;
  const merged = { ...base };
  for (const key of LIMIT_KEYS) {
    const value = overlay[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * 優先関係を対ごとに畳んで、ルールごとの「これより後に評価する相手」にする。
 *
 * 特異度の比較はここで 1 度だけ行う。判定のたびに `CompiledMatch` を持ち回らずに
 * 済ませるための前計算であり、順序そのものを固定するものではない。
 */
function precedenceEdges(
  compiled: readonly CompiledRule[],
): readonly (readonly string[])[] {
  return compiled.map((a) =>
    compiled.filter((b) => b !== a && rulePrecedes(a, b)).map((b) => b.key),
  );
}

/** a を b より先に評価するか。解決済みのルールに畳んだ関係を読む。 */
function precedes(a: ResolvedRule, b: ResolvedRule): boolean {
  return a.precedes.includes(b.key);
}

/**
 * スコープ全体の優先関係に閉路があればその説明を返す。
 *
 * 設定エラーの検査が閉路を先に弾くので通常は null になる。取りこぼした閉路を
 * そのまま持ち越すと、判定のたびに候補の並べ替えが詰まる。詰まった先で宣言順に
 * 落ちれば狭い deny を広い allow が追い越すので、ドキュメントを作らせない。
 */
function precedenceCycle(
  scopeName: string,
  rules: readonly ResolvedRule[],
): string | null {
  const outcome = precedenceOrder(rules, precedes);
  if (outcome.ok) return null;
  return cycleMessage(
    `スコープ ${scopeName} のルール`,
    outcome.cycle.map((rule) => rule.id),
  );
}

/**
 * スコープを特異度の降順に並べる。
 *
 * 選択は `selectScope` が包含で決めるので、この順序は addon が先頭から探せる
 * ようにするための便宜である。設定エラーの検査を通ったドキュメントでは、
 * 1 つのターゲットに一致するスコープは必ず全順序になっている。
 */
function orderScopes(
  scopes: readonly ResolvedScope[],
): Result<readonly ResolvedScope[]> {
  const outcome = precedenceOrder(
    scopes,
    (a, b) => compareTargetSpecificity(a.targets, b.targets) === "narrower",
  );
  if (outcome.ok) return { ok: true, value: outcome.ordered };
  return {
    ok: false,
    error: cycleMessage(
      "スコープ",
      outcome.cycle.map((scope) => scope.name),
    ),
  };
}

function cycleMessage(what: string, ring: readonly string[]): string {
  return [
    `設定エラー: ${what}の優先関係に閉路があり、評価順を決められません。`,
    `            ${[...ring, ...ring.slice(0, 1)].join(" → ")}`,
    "            順序を決められない設定でセッションを始めることはできません。",
  ].join("\n");
}

// ------------------------------------------------------ ドキュメントの受け渡し

/**
 * ドキュメントから注入の地の文を落とす。
 *
 * 解決済みドキュメントはファイルに書いて addon に渡す。`inject` の値は
 * `literal:` や `template:` の地の文をそのまま持つので、資格情報を直接書いた
 * 設定ではそれがそのままファイルに載る。addon はこのフィールドの形を検証する
 * だけで中身を読まない — 実際に注入されるヘッダーは broker が組み立てて
 * 決定と一緒に返す — ので、ファイルに地の文を置く理由がない。
 *
 * 落とすのは地の文だけで、ヘッダー名と参照する秘密の名前は残す。これは秘密では
 * なく、どのヘッダーがどの秘密で組まれるかを言うために要る。承認 UI が値を伏せて
 * 名前だけを見せるのと同じ線引きである。
 *
 * ホスト側の判定に使うドキュメントには手を入れない。broker はヘッダーを実際に
 * 組み立てるので、地の文が要る。
 */
export function withoutInjectLiterals(
  document: ResolvedDocument,
): ResolvedDocument {
  return {
    ...document,
    scopes: document.scopes.map((scope) => ({
      ...scope,
      inject: scope.inject.map(redactInject),
      rules: scope.rules.map((rule) => ({
        ...rule,
        inject: rule.inject.map(redactInject),
      })),
    })),
  };
}

/**
 * 1 つの注入から地の文を落とす。
 *
 * 値は文字列のまま返す。addon はこのフィールドを `{name, value}` の形で検証する
 * ので、形を変えると契約が壊れる。`template:` は参照だけを並べた姿にする。
 * 解析できない値は設定エラーの検査が先に弾くが、万一残っていても地の文を
 * 通さない側に倒す。
 */
function redactInject(inject: Inject): Inject {
  const parsed = parseInjectValue(inject.value);
  if (!parsed.ok) return { name: inject.name, value: "literal:" };
  switch (parsed.value.kind) {
    case "literal":
      return { name: inject.name, value: "literal:" };
    case "secret":
      return { name: inject.name, value: `secret:${parsed.value.name}` };
    case "template":
      return {
        name: inject.name,
        value: `template:${parsed.value.names.map((name) => `\${${name}}`).join("")}`,
      };
  }
}

// -------------------------------------------------------------------- 判定

export type DecisionReason =
  /** ルールの match が真になった。 */
  | "rule"
  /** ルールの match が判定不能になり、評価を打ち切った。 */
  | "indeterminate"
  /** スコープのどのルールも引き受けなかった。 */
  | "scope-fallback"
  /** どのスコープにも属さない。 */
  | "network-fallback";

export interface Decision {
  readonly action: Action;
  /** 承認の同一性に使う ID。fallback からは擬似 ID になる。 */
  readonly ruleId: string;
  readonly reason: DecisionReason;
  readonly scope: ResolvedScope | null;
  readonly rule: ResolvedRule | null;
  readonly expect: readonly ResolvedExpect[];
  /**
   * 帰結が最終的に `allow` になったときに適用するヘッダー。
   * 拒否したリクエストには適用しない。
   */
  readonly inject: readonly Inject[];
  readonly secrets: Readonly<Record<string, SecretDisposition>>;
  readonly limits: ResolvedLimits;
  readonly audit: AuditMode;
}

/**
 * ターゲットから 1 つのスコープを選ぶ。
 *
 * ターゲットパターンの特異度で決める。一致するスコープどうしは包含関係にある
 * ことが設定エラーの検査で保証されているので、最も狭いものが 1 つに定まる。
 */
export function selectScope(
  document: ResolvedDocument,
  address: TargetAddress,
): ResolvedScope | null {
  let best: ResolvedScope | null = null;
  for (const scope of document.scopes) {
    if (!scopeMatchesAddress(scope, address)) continue;
    if (best === null) {
      best = scope;
      continue;
    }
    if (compareTargetSpecificity(scope.targets, best.targets) === "narrower") {
      best = scope;
    }
  }
  return best;
}

function scopeMatchesAddress(
  scope: ResolvedScope,
  address: TargetAddress,
): boolean {
  return scope.targets.some(
    (target) =>
      hostMatches(target.host, address.host) &&
      (target.port === null || target.port === address.port),
  );
}

/**
 * 1 本のリクエストの帰結を決める。
 *
 * 設計「評価順」の 6 ステップをそのまま実装する。判定不能に到達した時点で
 * 評価を打ち切るのは、より特異なルールの判定不能をより広いルールで黙って
 * 回避されないようにするためである。
 */
export function decide(
  document: ResolvedDocument,
  address: TargetAddress,
  request: AuthzRequest,
): Decision {
  const scope = selectScope(document, address);
  if (scope === null) {
    return {
      action: document.fallback,
      ruleId: FALLBACK_RULE_KEY,
      reason: "network-fallback",
      scope: null,
      rule: null,
      expect: [],
      inject: [],
      secrets: document.defaults.secrets,
      limits: document.defaults.limits,
      audit: document.defaults.audit,
    };
  }

  for (const rule of orderedCandidates(scope, request)) {
    const truth = evaluateBody(
      { format: rule.match.bodyFormat, pointers: new Map(), graphql: null },
      request.body,
    );
    if (truth === "false") continue;
    return truth === "true"
      ? fromRule(scope, rule, rule.onMatch, "rule", rule.expect)
      : // 判定不能で終わったルールの受理条件は評価されない。解析できなかった
        // ボディに対して受理条件は何も言えないので、空で返す。
        fromRule(scope, rule, rule.onIndeterminate, "indeterminate", []);
  }

  return {
    action: scope.fallback,
    ruleId: scope.fallbackRuleId,
    reason: "scope-fallback",
    scope,
    rule: null,
    expect: [],
    inject: scope.inject,
    secrets: scope.secrets,
    limits: scope.limits,
    audit: scope.audit,
  };
}

function fromRule(
  scope: ResolvedScope,
  rule: ResolvedRule,
  action: Action,
  reason: DecisionReason,
  expect: readonly ResolvedExpect[],
): Decision {
  return {
    action,
    ruleId: rule.id,
    reason,
    scope,
    rule,
    expect,
    inject: rule.inject,
    secrets: rule.secrets,
    limits: rule.limits,
    audit: rule.audit,
  };
}

/**
 * このリクエストの候補を集め、その候補の中だけで評価順を決める。
 *
 * 設計「評価順」の手順 2 と 3 の順番をそのまま守る。先にスコープ全体を並べてから
 * 絞ると、候補になれないルールが候補どうしのタイブレークに口を出す。宣言順で
 * 決着する組はまさに「特異度で決着しない組」なので、そこに無関係なルールが
 * 混ざると、そのルールを 1 本足すだけで deny と allow が入れ替わる。
 */
function orderedCandidates(
  scope: ResolvedScope,
  request: AuthzRequest,
): readonly ResolvedRule[] {
  const path = pathForSelection(request.path);
  const candidates = scope.rules.filter((rule) =>
    isCandidate(rule.match, request.method, path),
  );
  if (candidates.length < 2) return candidates;

  const outcome = precedenceOrder(candidates, precedes);
  if (outcome.ok) return outcome.ordered;
  // 閉路のあるスコープからはドキュメントを作らないので、部分集合にも閉路はない。
  // それでも詰まったならドキュメントが壊れている。適当な順序で通すより止める。
  throw new Error(
    `スコープ ${scope.name} の候補を並べられませんでした: ${outcome.cycle
      .map((rule) => rule.id)
      .join(" → ")}`,
  );
}

/** メソッドとパスが一致するか。候補の集め方であり、ボディは見ない。 */
function isCandidate(
  match: ResolvedMatch,
  method: string,
  path: string,
): boolean {
  if (match.methods !== null && !match.methods.includes(method)) return false;
  return match.paths.some((pattern) => compiledPathMatches(pattern, path));
}

/**
 * 選択に使うパス。
 *
 * クエリ文字列は選択に一切参加しない。パスの正規化は行わない。パーセント復号も
 * 連続スラッシュの畳み込みも末尾スラッシュの除去も実施しない。
 */
export function pathForSelection(path: string): string {
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}
