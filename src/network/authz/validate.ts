/**
 * スコープ体系の設定エラーと警告。
 *
 * 設計「設定エラー」「設定エラーの提示」「設定の警告」「旧スキーマの検出」に
 * 対応する。判定そのものは段階 0 の relation.ts / specificity.ts / witness.ts を
 * 使い、ここは「どの組を突き合わせるか」と「どう見せるか」だけを持つ。
 *
 * 受理集合の交差を理由とするエラーは、関係だけを述べても書き手が直せないので、
 * 両方に一致する具体的なリクエストを 1 つ構成して添える。
 *
 * 提示に設定ファイルの行番号は載らない。Pkl を評価した値には行の情報が残らない
 * ためである。行番号を出せるのは、評価前の生ソースを走査する
 * `detectLegacyIdentifiers` だけである。
 */

import { containsIdentifier, maskNonCode } from "../../lib/pkl_source.ts";
import {
  type AuditMode,
  type AuthzConfig,
  type BodyMatchConfig,
  DEFAULT_AUDIT_MODE,
  DEFAULT_SECRET_DISPOSITIONS,
  type Expect,
  expandsToMultipleValues,
  FALLBACK_RULE_KEY,
  type Inject,
  injectReferences,
  LIMIT_CEILINGS,
  LIMIT_KEYS,
  type Limits,
  MAX_BODY_EXPECT_POINTER_CHARS,
  parseInjectValue,
  type ResolvedLimits,
  RULE_KEY_PATTERN,
  type RuleConfig,
  requiresJsonBody,
  type ScopeConfig,
  type SecretDisposition,
} from "./config.ts";
import {
  graphqlPathPrefixes,
  isGraphqlFieldPath,
} from "./graphql_selection.ts";
import { parsePathPattern } from "./pattern.ts";
import {
  type CompiledMatch,
  compileMatch,
  KNOWN_HTTP_METHODS,
  matchesIntersect,
  matchSubsumes,
  type NormalizedBody,
  normalizeMethod,
  parseTarget,
  targetSetsIntersect,
} from "./relation.ts";
import {
  compareSpecificity,
  compareTargetSpecificity,
  precedenceOrder,
} from "./specificity.ts";
import type { GraphqlMatch, Target } from "./types.ts";
import {
  describeRequest,
  describeTargetAddress,
  matchIntersectionWitness,
  targetIntersectionWitness,
} from "./witness.ts";

export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface CompiledRule {
  readonly scopeName: string;
  readonly key: string;
  /** 実 ID。`<スコープ名>.<キー>`。 */
  readonly id: string;
  readonly config: RuleConfig;
  /** 実行時の選択と設定診断に使う、値条件を含む完全な match。 */
  readonly match: CompiledMatch;
}

export interface CompiledScope {
  readonly name: string;
  readonly config: ScopeConfig;
  readonly targets: readonly Target[];
  /** 宣言順のルール。解析に失敗したルールは含まれない。 */
  readonly rules: readonly CompiledRule[];
  /** `network.defaults` を畳んだ、このスコープの実効的な秘密の扱い。 */
  readonly dispositions: ReadonlyMap<string, SecretDisposition>;
}

export interface CompileOutcome {
  readonly scopes: readonly CompiledScope[];
  readonly diagnostics: readonly Diagnostic[];
}

export function validateAuthzConfig(
  config: AuthzConfig,
): readonly Diagnostic[] {
  return compileAuthzConfig(config).diagnostics;
}

export function compileAuthzConfig(config: AuthzConfig): CompileOutcome {
  const diagnostics: Diagnostic[] = [];
  const secrets = config.secrets ?? {};
  const defaults = config.network.defaults ?? {};
  // Pkl の Mapping は既定値を amend するので、書かれた名前だけが上書きされ、
  // 書かれなかった `"*"` の既定は残る。
  const baseDispositions = toDispositionMap({
    ...DEFAULT_SECRET_DISPOSITIONS,
    ...defaults.secrets,
  });

  const defaultLimits = checkLimits(
    diagnostics,
    defaults.limits,
    "network.defaults",
    LIMIT_CEILINGS,
  );

  const scopes: CompiledScope[] = [];
  for (const [name, scopeConfig] of Object.entries(config.network.scopes)) {
    scopes.push(
      compileScope(diagnostics, name, scopeConfig, {
        dispositions: baseDispositions,
        audit: defaults.audit,
        secrets,
        limits: defaultLimits,
      }),
    );
  }

  checkScopeOverlaps(diagnostics, scopes);
  checkEffectiveIdCollisions(diagnostics, scopes);
  for (const scope of scopes) {
    checkRuleOverlaps(diagnostics, scope);
    checkOverrides(diagnostics, scope);
    checkPrecedenceCycles(diagnostics, scope);
    checkCoveringAllow(diagnostics, scope);
  }
  checkMaskProxy(diagnostics, config, scopes);

  return { scopes, diagnostics };
}

// ---------------------------------------------------------------- スコープ

interface ScopeContext {
  /** `network.defaults.secrets` を畳んだ秘密の扱い。 */
  readonly dispositions: ReadonlyMap<string, SecretDisposition>;
  readonly audit: AuditMode | undefined;
  readonly secrets: Readonly<Record<string, { readonly from: string }>>;
  /** `network.defaults.limits` を畳んだ、スコープが継承する天井。 */
  readonly limits: ResolvedLimits;
}

function compileScope(
  diagnostics: Diagnostic[],
  name: string,
  config: ScopeConfig,
  context: ScopeContext,
): CompiledScope {
  if (config.targets.length === 0) {
    diagnostics.push(error(`scope ${name} has no targets.`));
  }
  const targets: Target[] = [];
  for (const source of config.targets) {
    const parsed = parseTarget(source);
    if (!parsed.ok) {
      diagnostics.push(
        error(`scope ${name} has invalid targets: ${parsed.error}`),
      );
      continue;
    }
    targets.push(parsed.value);
  }

  const scopeLimits = checkLimits(
    diagnostics,
    config.limits,
    `scope ${name}`,
    context.limits,
  );

  const dispositions = mergeDispositions(context.dispositions, config.secrets);
  const rules: CompiledRule[] = [];
  const seenInjectFaults = new Set<string>();

  checkInjects(
    diagnostics,
    seenInjectFaults,
    `scope ${name}`,
    config.inject ?? [],
    dispositions,
    context.secrets,
  );

  for (const [key, ruleConfig] of Object.entries(config.rules ?? {})) {
    const id = `${name}.${key}`;
    if (!RULE_KEY_PATTERN.test(key)) {
      diagnostics.push(
        error(
          `rule key ${JSON.stringify(key)} in scope ${name} does not match [a-z][a-z0-9._-]{0,63}.`,
        ),
      );
      continue;
    }
    checkLimits(diagnostics, ruleConfig.limits, `rule ${id}`, scopeLimits);
    const ruleDispositions = mergeDispositions(
      dispositions,
      ruleConfig.secrets,
    );
    checkInjects(
      diagnostics,
      seenInjectFaults,
      `rule ${id}`,
      effectiveInject(config.inject, ruleConfig.inject),
      ruleDispositions,
      context.secrets,
    );
    checkExpects(
      diagnostics,
      id,
      ruleConfig,
      effectiveAudit(context.audit, config.audit, ruleConfig.audit),
    );

    const match = compileRuleMatch(diagnostics, id, ruleConfig);
    if (match === null) continue;
    rules.push({
      scopeName: name,
      key,
      id,
      config: ruleConfig,
      match,
    });
  }

  return { name, config, targets, rules, dispositions };
}

function compileRuleMatch(
  diagnostics: Diagnostic[],
  id: string,
  rule: RuleConfig,
): CompiledMatch | null {
  const captureNames = new Set<string>();
  let broken = false;
  for (const source of rule.match.paths) {
    const parsed = parsePathPattern(source);
    if (!parsed.ok) {
      diagnostics.push(error(`rule ${id} path pattern: ${parsed.error}`));
      broken = true;
      continue;
    }
    for (const segment of parsed.value.segments) {
      if (segment.kind === "capture") captureNames.add(segment.name);
    }
  }
  if (rule.match.paths.length === 0) {
    diagnostics.push(
      error(
        `rule ${id} has no paths. Its accepted set is empty, so this rule never fires.`,
      ),
    );
    broken = true;
  }

  for (const [name, values] of Object.entries(rule.match.captures ?? {})) {
    if (!captureNames.has(name)) {
      diagnostics.push(
        error(
          `rule ${id} constrains the capture ${name}, which appears in no path pattern.`,
        ),
      );
      continue;
    }
    if (values.length === 0) {
      diagnostics.push(
        error(
          `rule ${id} has an empty Listing at captures.${name}. Its accepted set is empty, so this rule never fires.`,
        ),
      );
    }
  }

  checkMethods(diagnostics, id, rule.match.methods);
  broken = checkBodyMatch(diagnostics, id, rule.match.body) || broken;

  if (broken) return null;
  const compiled = compileMatch(rule.match);
  if (!compiled.ok) {
    diagnostics.push(error(`rule ${id} match: ${compiled.error}`));
    return null;
  }
  return compiled.value;
}

function checkBodyMatch(
  diagnostics: Diagnostic[],
  id: string,
  body: BodyMatchConfig | undefined,
): boolean {
  if (body === undefined) return false;

  let broken = false;
  const conditions: readonly [string, boolean][] = [
    ["equals", Object.keys(body.equals ?? {}).length > 0],
    ["oneOf", Object.keys(body.oneOf ?? {}).length > 0],
    ["graphql", body.graphql !== undefined],
  ];
  for (const [name, present] of conditions) {
    if (body.format === "json" || !present) continue;
    diagnostics.push(
      error(
        `rule ${id} cannot combine match.body.format = "${body.format}" with ${name}. Body conditions require format = "json".`,
      ),
    );
    broken = true;
  }

  return (
    checkBodyConditions(
      diagnostics,
      `rule ${id} match.body.`,
      body,
      "this rule never fires",
    ) || broken
  );
}

/**
 * `match.body` と `BodyExpect` に共通するボディ条件の形を検査する。
 *
 * addon は解決済みドキュメントを同じ形で検証し直し、読めない条件を 1 つでも
 * 見つけるとドキュメント全体を拒否する。ここで止めないと、設定の誤りが
 * セッション開始時ではなく最初のリクエストの 403 として現れる。
 *
 * `prefix` は診断の主語 (`ルール x の match.body.` / `ルール x の expect[0] の `)、
 * `never` は空の Listing が意味する帰結である。
 */
function checkBodyConditions(
  diagnostics: Diagnostic[],
  prefix: string,
  body: Pick<BodyMatchConfig, "equals" | "oneOf" | "graphql">,
  never: string,
): boolean {
  let broken = false;
  const fail = (message: string): void => {
    diagnostics.push(error(`${prefix}${message}`));
    broken = true;
  };

  for (const [pointer, value] of Object.entries(body.equals ?? {})) {
    if (!isValidJsonPointer(pointer)) {
      fail(`equals ${pointer} is not a valid RFC 6901 JSON Pointer.`);
    }
    if (!isFiniteJsonScalar(value)) {
      fail(
        `equals ${pointer} must be a string, a finite number, or a boolean.`,
      );
    }
  }
  for (const [pointer, values] of Object.entries(body.oneOf ?? {})) {
    if (!isValidJsonPointer(pointer)) {
      fail(`oneOf ${pointer} is not a valid RFC 6901 JSON Pointer.`);
    }
    if (values.length === 0) {
      fail(
        `oneOf ${pointer} is an empty Listing. The accepted set is empty, so ${never}.`,
      );
    }
    if (!(values as readonly unknown[]).every(isFiniteJsonScalar)) {
      fail(
        `oneOf ${pointer} may only contain strings, finite numbers, or booleans.`,
      );
    }
  }

  const graphql = body.graphql;
  if (graphql === undefined) return broken;
  checkGraphqlCondition(fail, graphql, never);
  return broken;
}

/** `GraphqlMatch` が持てるキー。これ以外は綴り違いか旧形式である。 */
const GRAPHQL_KEYS: ReadonlySet<string> = new Set([
  "at",
  "operations",
  "fieldPaths",
  "fieldArguments",
]);

/**
 * GraphQL 条件の形を検査する。`match.body.graphql` と `BodyExpect.graphql` で
 * 同じ検査を使う。片方だけが新しい語彙を受け入れると、同じ設定が match では
 * 拒まれ expect では通るといった食い違いが生まれる。
 *
 * 旧 `rootFields` / 全域 `arguments` は「未知のキー」として拒む。読み替えも補完も
 * しない。自動変換は、旧 `rootFields` が許していた「その root の下の任意の取得」を
 * 経路の集合として書き直せないので、黙って広い許可を作ってしまう。
 */
function checkGraphqlCondition(
  fail: (message: string) => void,
  graphql: GraphqlMatch,
  never: string,
): void {
  for (const key of Object.keys(graphql)) {
    if (GRAPHQL_KEYS.has(key)) continue;
    fail(
      `graphql has an unknown key ${JSON.stringify(key)}. Allowed keys: ${[...GRAPHQL_KEYS].join(", ")}.`,
    );
  }
  if (graphql.at !== undefined && !isValidJsonPointer(graphql.at)) {
    fail(`graphql.at ${graphql.at} is not a valid RFC 6901 JSON Pointer.`);
  }
  if (graphql.operations.length === 0) {
    fail(
      `graphql.operations is an empty Listing. The accepted set is empty, so ${never}.`,
    );
  }

  // `fieldPaths` は必須・非空。経路を制約しない GraphQL 条件は提供しない。
  // 省略を「制約なし」に倒すと、root だけを見ていた旧条件と同じ横断を許す。
  const fieldPaths = graphql.fieldPaths as readonly string[] | null | undefined;
  if (fieldPaths === undefined || fieldPaths === null) {
    fail(
      "graphql.fieldPaths is missing. Paths to the leaves you allow are required; a GraphQL condition cannot leave paths unconstrained.",
    );
  } else if (fieldPaths.length === 0) {
    fail(
      `graphql.fieldPaths is an empty Listing. The accepted set is empty, so ${never}.`,
    );
  }
  for (const path of fieldPaths ?? []) {
    if (isGraphqlFieldPath(path)) continue;
    fail(
      `graphql.fieldPaths entry ${JSON.stringify(path)} is not a GraphQL selection path.` +
        ` It must start with "/" and every element must be a GraphQL name; wildcards, empty elements, a trailing "/", and JSON Pointer escapes are not allowed.`,
    );
  }

  // `fieldArguments` のキーは、許可末端そのものか、その途中の経路でなければ
  // ならない。どちらでもない経路の field はこの条件の下では現れ得ないので、
  // そこに書いた引数条件は何も制約しない。
  const leaves = new Set((fieldPaths ?? []).filter(isGraphqlFieldPath));
  const prefixes = graphqlPathPrefixes(leaves);
  for (const [path, args] of Object.entries(graphql.fieldArguments ?? {})) {
    if (!isGraphqlFieldPath(path)) {
      fail(
        `graphql.fieldArguments key ${JSON.stringify(path)} is not a GraphQL selection path. It cannot appear in a document, so its constraints constrain nothing.`,
      );
    } else if (!leaves.has(path) && !prefixes.has(path)) {
      fail(
        `graphql.fieldArguments key ${JSON.stringify(path)} is neither a leaf nor a prefix of any fieldPaths entry. Fields on this path are not allowed, so its constraints constrain nothing.`,
      );
    }
    const names = Object.entries(args ?? {});
    if (names.length === 0) {
      fail(
        `graphql.fieldArguments ${path} is an empty Mapping. It requires no argument, so the intent of writing it is lost.`,
      );
    }
    for (const [name, values] of names) {
      if (!isGraphqlName(name)) {
        fail(
          `graphql.fieldArguments ${path} key ${JSON.stringify(name)} is not a GraphQL name. It cannot appear in a document, so this argument can never be satisfied.`,
        );
      }
      if (values.length === 0) {
        fail(
          `graphql.fieldArguments ${path} ${name} is an empty Listing. The accepted set is empty, so ${never}.`,
        );
      }
    }
  }
}

function isValidJsonPointer(pointer: string): boolean {
  return (
    pointer === "" || (pointer.startsWith("/") && !/~(?![01])/u.test(pointer))
  );
}

/**
 * GraphQL の Name (先頭が `_` か英字、以降が `_`・英数字) か。root field 名も引数名も
 * document ではこの形でしか書けない。
 */
function isGraphqlName(value: string): boolean {
  return /^[_A-Za-z][_0-9A-Za-z]*$/u.test(value);
}

function isFiniteJsonScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * 知らない綴りのメソッドを警告する。
 *
 * 綴りの大小は畳むので `post` は黙って通る。畳んでも既知のメソッドにならない
 * 綴りは書き間違いであることが多く、そのルールは 1 度も発火しないまま消える。
 * 拡張メソッドを禁じる根拠はないので、止めずに知らせるだけにする。
 */
function checkMethods(
  diagnostics: Diagnostic[],
  id: string,
  methods: readonly string[] | undefined,
): void {
  for (const method of methods ?? []) {
    if (KNOWN_HTTP_METHODS.has(normalizeMethod(method))) continue;
    diagnostics.push(
      warning(
        `rule ${id} match.methods contains ${JSON.stringify(method)}, which is not a known HTTP method.` +
          ` If the spelling is wrong, this rule never fires.`,
      ),
    );
  }
}

// ---------------------------------------------------------------- 受理条件

function checkExpects(
  diagnostics: Diagnostic[],
  id: string,
  rule: RuleConfig,
  audit: AuditMode,
): void {
  const expects = rule.expect ?? [];
  const format = rule.match.body?.format ?? null;

  for (const [index, expect] of expects.entries()) {
    if (requiresJsonBody(expect) && format !== "json") {
      diagnostics.push(
        error(
          `rule ${id} expect[${index}] (${expect.kind}) requires match.body.format = "json".`,
        ),
      );
    }
    checkExpectConditions(diagnostics, id, index, expect);
  }

  if (!expects.some((expect) => expect.onViolation === "allow")) return;
  if (audit !== "always") {
    diagnostics.push(
      error(
        `rule ${id} has onViolation = "allow", which requires audit = "always".` +
          ` Letting violations through without a record is not allowed.`,
      ),
    );
  }
}

function checkExpectConditions(
  diagnostics: Diagnostic[],
  id: string,
  index: number,
  expect: Expect,
): void {
  const where = `rule ${id} expect[${index}]`;
  if (expect.kind === "unionShape") {
    if (expect.allowed.length === 0) {
      diagnostics.push(
        error(`${where} allowed is an empty Listing. It is always violated.`),
      );
    }
    return;
  }
  if (expect.kind !== "body") return;
  checkBodyConditions(
    diagnostics,
    `${where} `,
    expect,
    "this condition is never satisfied",
  );
  // 違反レコードは Pointer を値に含めて broker へ送る。長さの上限を超えた
  // Pointer の違反レコードは broker に拒まれ、そのリクエストは承認できない。
  for (const [field, pointers] of [
    ["equals", Object.keys(expect.equals ?? {})],
    ["oneOf", Object.keys(expect.oneOf ?? {})],
  ] as const) {
    for (const pointer of pointers) {
      if (pointer.length <= MAX_BODY_EXPECT_POINTER_CHARS) continue;
      diagnostics.push(
        error(
          `${where} ${field} Pointer ${pointer.slice(0, 32)}… is ${pointer.length} characters, over the ${MAX_BODY_EXPECT_POINTER_CHARS}-character limit. Violation records carry this Pointer as a value, so a longer Pointer produces violation records that cannot be approved.`,
        ),
      );
    }
  }
}

// -------------------------------------------------------------------- 予算

/**
 * 予算は下げる方向にしか変えられない。天井は固定の既定値ではなく、**その段が
 * 継承した値**である。段を下るほど狭まるので、内側の段が外側より広い数を書いたら
 * 継承が意味を失う。
 *
 * 継承後の値を返し、呼び手が次の段の天井として渡せるようにする。上回った値は
 * 採用せず、天井のまま下へ渡す。エラーの設定はどうせ起動しないが、後続の診断が
 * 「ありえない広さ」を前提に出るのを避ける。
 */
function checkLimits(
  diagnostics: Diagnostic[],
  limits: Limits | undefined,
  where: string,
  inherited: ResolvedLimits,
): ResolvedLimits {
  if (limits === undefined) return inherited;
  const effective = { ...inherited };
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (value === undefined) continue;
    if (value > inherited[key]) {
      diagnostics.push(
        error(
          `${where} limits.${key} = ${value} exceeds the inherited ceiling of ${inherited[key]}. Budgets can only be lowered.`,
        ),
      );
      continue;
    }
    effective[key] = value;
  }
  return effective;
}

// ------------------------------------------------------------ 秘密と注入

function toDispositionMap(
  source: Readonly<Record<string, SecretDisposition>>,
): ReadonlyMap<string, SecretDisposition> {
  return new Map(Object.entries(source));
}

/** 下の段の同名キーが上の段を上書きする。 */
function mergeDispositions(
  base: ReadonlyMap<string, SecretDisposition>,
  overlay: Readonly<Record<string, SecretDisposition>> | undefined,
): ReadonlyMap<string, SecretDisposition> {
  if (overlay === undefined) return base;
  const merged = new Map(base);
  for (const [name, disposition] of Object.entries(overlay)) {
    merged.set(name, disposition);
  }
  return merged;
}

/** 個別の名前は `"*"` に勝つ。 */
export function dispositionOf(
  dispositions: ReadonlyMap<string, SecretDisposition>,
  name: string,
): SecretDisposition {
  return dispositions.get(name) ?? dispositions.get("*") ?? "mask";
}

/** スコープの inject にルールの inject をヘッダー名で突き合わせる。同名はルール側。 */
export function effectiveInject(
  scope: readonly Inject[] | undefined,
  rule: readonly Inject[] | undefined,
): readonly Inject[] {
  const merged = new Map<string, Inject>();
  for (const entry of scope ?? []) merged.set(entry.name, entry);
  for (const entry of rule ?? []) merged.set(entry.name, entry);
  return [...merged.values()];
}

function checkInjects(
  diagnostics: Diagnostic[],
  seen: Set<string>,
  where: string,
  injects: readonly Inject[],
  dispositions: ReadonlyMap<string, SecretDisposition>,
  secrets: Readonly<Record<string, { readonly from: string }>>,
): void {
  for (const entry of injects) {
    const parsed = parseInjectValue(entry.value);
    if (!parsed.ok) {
      // 値の代わりにヘッダー名を出す。ヘッダー名は秘密ではなく、どの inject を
      // 直せばよいかはこれで一意に決まる。重複の抑止は値で行うが、こちらは
      // メッセージにも記録にも出ない。
      if (once(seen, `value:${entry.value}`)) {
        diagnostics.push(
          error(`${where} inject header ${entry.name}: ${parsed.error}`),
        );
      }
      continue;
    }
    for (const name of injectReferences(parsed.value)) {
      const secret = secrets[name];
      if (secret === undefined) {
        if (once(seen, `unknown:${name}`)) {
          diagnostics.push(
            error(
              `${where} inject references ${name}, which does not exist in the secrets registry.`,
            ),
          );
        }
        continue;
      }
      if (expandsToMultipleValues(secret)) {
        if (once(seen, `multi:${name}`)) {
          diagnostics.push(
            error(
              `${where} inject references the secret ${name} (${secret.from}), which expands to multiple values. Injection requires a single value.`,
            ),
          );
        }
      }
      const disposition = dispositionOf(dispositions, name);
      if (
        disposition !== "inject" &&
        once(seen, `disp:${name}:${disposition}`)
      ) {
        diagnostics.push(
          error(
            `${where} inject references the secret ${name}, whose effective disposition is "${disposition}". Secrets referenced from inject must be "inject".`,
          ),
        );
      }
    }
  }
}

function once(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function checkMaskProxy(
  diagnostics: Diagnostic[],
  config: AuthzConfig,
  scopes: readonly CompiledScope[],
): void {
  if (config.mask?.proxy !== false) return;
  for (const scope of scopes) {
    const levels: ReadonlyMap<string, SecretDisposition>[] = [
      scope.dispositions,
    ];
    for (const rule of scope.rules) {
      levels.push(mergeDispositions(scope.dispositions, rule.config.secrets));
    }
    for (const level of levels) {
      for (const disposition of level.values()) {
        if (disposition !== "mask" && disposition !== "forbid") continue;
        diagnostics.push(
          error(
            `scope ${scope.name} uses "${disposition}" as a secret disposition, so mask.proxy = false is not allowed.` +
              ` If you do not want masking at the proxy, set network.defaults.secrets { ["*"] = "ignore" } explicitly.`,
          ),
        );
        return;
      }
    }
  }
}

// -------------------------------------------------------------- 重なりの検査

function checkScopeOverlaps(
  diagnostics: Diagnostic[],
  scopes: readonly CompiledScope[],
): void {
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      const a = scopes[i] as CompiledScope;
      const b = scopes[j] as CompiledScope;
      if (!targetSetsIntersect(a.targets, b.targets)) continue;
      const order = compareTargetSpecificity(a.targets, b.targets);
      // 包含関係があるときは特異な側が勝つので共存できる。等しい集合と、
      // どちらも他方を包含しない集合は、属するスコープが 1 つに定まらない。
      if (order === "narrower" || order === "wider") continue;
      diagnostics.push(
        error(describeScopeConflict(a, b, order === "equivalent")),
      );
    }
  }
}

function describeScopeConflict(
  a: CompiledScope,
  b: CompiledScope,
  equivalent: boolean,
): string {
  const witness = targetIntersectionWitness(a.targets, b.targets);
  const lines = equivalent
    ? [
        `config error: scopes ${a.name} and ${b.name} have identical target sets.`,
        "            The same host cannot be split across two scopes.",
        "            Use rules within a single scope to distinguish requests to the same host.",
        "",
      ]
    : [
        `config error: the target sets of scopes ${a.name} and ${b.name} intersect.`,
        "            Neither contains the other, so which scope applies is undecidable.",
        "",
      ];
  if (witness !== null) {
    lines.push(
      "  A target belonging to both:",
      `    ${describeTargetAddress(witness)}`,
      "",
    );
  }
  lines.push(
    ...alignedRows([
      [a.name, a.config.targets.join(" ")],
      [b.name, b.config.targets.join(" ")],
    ]),
    "",
    "  How to fix:",
    ...(equivalent
      ? ["    - Merge the two scopes into one and distinguish cases with rules"]
      : [
          "    - Make one side's targets match down to the port",
          "    - Narrow one side's targets so the other contains them",
        ]),
  );
  return lines.join("\n");
}

// -------------------------------------------------------- 実 ID の一意性

/** 実 ID を 1 つ占める宣言。表示のために、名乗りを 2 列に分けて持つ。 */
interface IdDeclaration {
  readonly id: string;
  readonly scopeName: string;
  /** そのスコープの中での名乗り。 */
  readonly detail: string;
}

/**
 * 2 つの宣言が同じ実 ID を作る設定をエラーにする。
 *
 * 実 ID は `<スコープ名>.<キー>` の連結である。キー構文 `[a-z][a-z0-9._-]{0,63}`
 * は `.` を許すので、この連結はどこで切れるか一意に決まらない。スコープ github の
 * ルール api.read と、スコープ github.api のルール read は、どちらも実 ID
 * github.api.read になる。
 *
 * 実 ID は承認の同一性 (ルール ID, ターゲット) の半分であり、監査記録がルールを
 * 指す名前でもある。2 つの宣言が同じ名前を持つと、一方に向けて押された承認が
 * もう一方のリクエストにも届き、その承認を出した人が見ていない資格情報が
 * 付いて送られうる。名前が一意でないことは書いた側にしか直せないので、
 * セッションを始める前に止める。
 */
function checkEffectiveIdCollisions(
  diagnostics: Diagnostic[],
  scopes: readonly CompiledScope[],
): void {
  const seen = new Map<string, IdDeclaration>();
  for (const declaration of idDeclarations(scopes)) {
    const previous = seen.get(declaration.id);
    if (previous === undefined) {
      seen.set(declaration.id, declaration);
      continue;
    }
    diagnostics.push(error(describeIdCollision(previous, declaration)));
  }
}

function idDeclarations(
  scopes: readonly CompiledScope[],
): readonly IdDeclaration[] {
  const declarations: IdDeclaration[] = [];
  for (const scope of scopes) {
    // 擬似 ID も実 ID の空間を占める。スコープ名には構文の制約が無いので、
    // 「`$` はキー構文に含まれない」だけでは衝突しないと言い切れない。
    declarations.push({
      id: fallbackRuleId(scope.name),
      scopeName: scope.name,
      detail: "fallback",
    });
    for (const rule of scope.rules) {
      declarations.push({
        id: rule.id,
        scopeName: scope.name,
        detail: `rule ${JSON.stringify(rule.key)}`,
      });
    }
  }
  return declarations;
}

function describeIdCollision(a: IdDeclaration, b: IdDeclaration): string {
  return [
    `config error: two declarations produce the same effective id ${a.id}.`,
    "            Approvals and audit records both refer to rules by effective",
    "            id, so it is undecidable which declaration an answer belongs to.",
    "            An approval given for one could let the other's requests through.",
    "",
    ...alignedRows([
      [`scope ${a.scopeName}`, a.detail],
      [`scope ${b.scopeName}`, b.detail],
    ]),
    "",
    "  How to fix:",
    "    - Change one rule's key",
    "    - Change one scope's name",
  ].join("\n");
}

function checkRuleOverlaps(
  diagnostics: Diagnostic[],
  scope: CompiledScope,
): void {
  const rules = scope.rules;
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i] as CompiledRule;
      const b = rules[j] as CompiledRule;
      if (!matchesIntersect(a.match, b.match)) continue;
      if (compareSpecificity(a.match, b.match) !== "incomparable") continue;
      // 一方が他方を名指ししていれば優先の向きが決まる。両方が名指しした場合は
      // 向きが決まらないが、それは優先関係の閉路であり checkPrecedenceCycles が
      // 報告する。ここで重ねて報告すると同じ 1 つの誤りが 2 度出る。
      if (eitherNamesTheOther(a, b)) continue;
      diagnostics.push(error(describeRuleConflict(a, b)));
    }
  }
}

function eitherNamesTheOther(a: CompiledRule, b: CompiledRule): boolean {
  return (
    (a.config.overrides ?? []).includes(b.key) ||
    (b.config.overrides ?? []).includes(a.key)
  );
}

/**
 * a を b より先に評価するか。
 *
 * `overrides` を書いた側が先に来る。どちらも書いていなければ特異度の降順に従う。
 * 解決器の評価順もこの関係を使う。順序の定義が 2 か所にあると片方だけが直る事故が
 * 起こるので、検査と解決で同じ関数を読む。
 */
export function rulePrecedes(a: CompiledRule, b: CompiledRule): boolean {
  if ((a.config.overrides ?? []).includes(b.key)) return true;
  if ((b.config.overrides ?? []).includes(a.key)) return false;
  return compareSpecificity(a.match, b.match) === "narrower";
}

/**
 * 優先関係の閉路を設定エラーにする。
 *
 * 閉路には解決可能な評価順が存在しない。互いに `overrides` を書いた組がもっとも
 * 素朴な形だが、`overrides` と特異度が混ざった 3 本以上の輪でも起こる。どちらも
 * 「どのルールを先に評価するか」が定まらないので、スコープの選択規則そのものが
 * 成り立たなくなる。設定を書いた側にしか直せない。
 */
function checkPrecedenceCycles(
  diagnostics: Diagnostic[],
  scope: CompiledScope,
): void {
  const outcome = precedenceOrder(scope.rules, rulePrecedes);
  if (outcome.ok) return;
  diagnostics.push(error(describePrecedenceCycle(scope, outcome.cycle)));
}

function describePrecedenceCycle(
  scope: CompiledScope,
  cycle: readonly CompiledRule[],
): string {
  // 輪なので、末尾の次は先頭に戻る。
  const next = (index: number) =>
    cycle[(index + 1) % cycle.length] as CompiledRule;
  const keys = cycle.map((rule) => rule.key);
  const ring = [...keys, ...keys.slice(0, 1)].join(" → ");
  const edges = cycle.map((rule, index) =>
    describePrecedenceEdge(rule, next(index)),
  );
  return [
    `config error: rule precedence in scope ${scope.name} is cyclic.`,
    `            ${ring}`,
    "            Which rule to evaluate first is undecidable, so",
    "            specificity-based selection breaks down across the scope.",
    "",
    "  Precedence edges forming the cycle:",
    ...edges.map((line) => `    ${line}`),
    "",
    "  How to fix:",
    "    - Remove one side's overrides so precedence points a single way",
    "    - Narrow one side's match so overrides are not needed",
    "    - Add a third rule covering the intersection",
  ].join("\n");
}

function describePrecedenceEdge(a: CompiledRule, b: CompiledRule): string {
  if ((a.config.overrides ?? []).includes(b.key)) {
    return `${a.id} precedes ${b.id} via overrides { ${JSON.stringify(b.key)} }`;
  }
  return `${a.id} precedes ${b.id} by specificity`;
}

function describeRuleConflict(a: CompiledRule, b: CompiledRule): string {
  const witness = matchIntersectionWitness(a.match, b.match);
  const lines = [
    `config error: the accepted sets of rules ${a.id} and ${b.id} intersect.`,
    "            Neither contains the other, so which rule applies is undecidable.",
    "",
  ];
  if (witness !== null) {
    lines.push(
      "  A request matching both:",
      ...describeRequest(witness).map((line) => `    ${line}`),
      "",
    );
  }
  lines.push(
    ...alignedRows(
      [a, b].map((rule) => [
        rule.id,
        describeMethods(rule),
        rule.config.match.paths.join(" "),
        ...(hasBodyCondition(a) || hasBodyCondition(b)
          ? [describeBodyCondition(rule.match.body)]
          : []),
      ]),
    ),
    "",
    "  How to fix:",
    `    - Add overrides { ${JSON.stringify(a.key)} } to ${b.id}`,
    "    - Narrow one side's match",
    "    - Add a third rule covering the intersection",
  );
  return lines.join("\n");
}

function describeMethods(rule: CompiledRule): string {
  const methods = rule.config.match.methods;
  return methods === undefined || methods.length === 0
    ? "(all methods)"
    : methods.join("|");
}

function hasBodyCondition(rule: CompiledRule): boolean {
  return rule.match.body.format !== null;
}

/**
 * ボディ条件を 1 行に畳む。
 *
 * GraphQL のルールは `POST /graphql` 1 本を分け合うので、メソッドとパスの列が
 * 2 行とも同じになる。違いはボディ条件にしかなく、それを表に出さないと書き手は
 * どちらを狭めればよいか分からない。値は設定から来た文字列なので、そのまま載せる。
 */
function describeBodyCondition(body: NormalizedBody): string {
  if (body.format === null) return "no body condition";
  const parts = [`body ${body.format}`];
  for (const [pointer, values] of body.pointers) {
    parts.push(
      `${pointer === "" ? "(root)" : pointer}=${values.map((value) => JSON.stringify(value)).join("|")}`,
    );
  }
  const graphql = body.graphql;
  if (graphql !== null) {
    parts.push(
      `graphql ${graphql.at === "" ? "(root)" : graphql.at}`,
      `operations=${graphql.operations.join("|")}`,
    );
    parts.push(`fieldPaths=${graphql.fieldPaths.join("|")}`);
    for (const [path, args] of graphql.fieldArguments) {
      for (const [name, values] of args) {
        parts.push(
          `fieldArguments.${path}.${name}=${values.map((value) => JSON.stringify(value)).join("|")}`,
        );
      }
    }
  }
  return parts.join(" ");
}

/** 列を揃えた 2 行の表を作る。書き手が差分を目で拾えるようにするため。 */
function alignedRows(rows: readonly (readonly string[])[]): readonly string[] {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let column = 0; column < columns; column++) {
    widths.push(Math.max(...rows.map((row) => (row[column] ?? "").length)));
  }
  return rows.map((row) => {
    const cells = row.map((cell, column) =>
      column === row.length - 1 ? cell : cell.padEnd(widths[column] as number),
    );
    return `  ${cells.join("  ")}`;
  });
}

function checkOverrides(diagnostics: Diagnostic[], scope: CompiledScope): void {
  const byKey = new Map(scope.rules.map((rule) => [rule.key, rule]));
  let total = 0;
  for (const rule of scope.rules) {
    const overrides = rule.config.overrides ?? [];
    total += overrides.length;
    for (const key of overrides) {
      if (key === rule.key) {
        diagnostics.push(
          error(`rule ${rule.id} has overrides pointing at itself.`),
        );
        continue;
      }
      const other = byKey.get(key);
      if (other === undefined) {
        diagnostics.push(
          error(
            `rule ${rule.id} has overrides pointing at ${scope.name}.${key}, which does not exist.`,
          ),
        );
        continue;
      }
      if (!matchesIntersect(rule.match, other.match)) {
        diagnostics.push(
          error(
            `rule ${rule.id} has overrides pointing at ${other.id}, whose accepted set does not intersect. Stating precedence is meaningless.`,
          ),
        );
      }
    }
  }
  if (total > scope.rules.length && scope.rules.length > 0) {
    diagnostics.push(
      warning(
        `scope ${scope.name} has ${total} overrides for ${scope.rules.length} rules.` +
          ` Specificity-based selection is degenerating into a hand-written ordering.`,
      ),
    );
  }
}

/**
 * ボディ条件を持つ `match` のルールが、同一スコープ内のより広い無条件 `allow`
 * ルールに覆われている。条件を外れたリクエストは広い側に拾われるので、意図が
 * 制限であれば条件は `expect` に置くべきである。
 */
function checkCoveringAllow(
  diagnostics: Diagnostic[],
  scope: CompiledScope,
): void {
  for (const narrow of scope.rules) {
    if (narrow.config.match.body === undefined) continue;
    for (const wide of scope.rules) {
      if (wide === narrow) continue;
      if (wide.config.onMatch !== "allow") continue;
      if (wide.config.match.body !== undefined) continue;
      if (!matchSubsumes(narrow.match, wide.match)) continue;
      diagnostics.push(
        warning(
          `the body condition of rule ${narrow.id} is covered by the broader unconditional allow rule ${wide.id} in the same scope.` +
            ` Requests outside the condition are caught and let through by ${wide.id}, so if the intent is restriction, put the condition on expect, not match.`,
        ),
      );
    }
  }
}

// ------------------------------------------------------------ 旧識別子の検出

/**
 * 廃止した識別子から移行先への対応。
 *
 * Pkl の `Unresolved reference` は移行先を名指ししないので、評価より前に生の
 * ソースを走査してこの案内を出す。互換モードではない。旧識別子を含む設定は
 * 動かない。
 */
const LEGACY_IDENTIFIERS: readonly (readonly [string, string])[] = [
  ["reviewRules", "Migrate to network.scopes."],
  ["ReviewRule", "Migrate to Scope and Rule."],
  ["credentials", "Migrate to the secrets registry and scope inject."],
  [
    "CredentialRule",
    "Migrate to scope or rule inject. The matcher lives in match.",
  ],
  ["CredentialValSpec", 'Migrate to secrets { [name] { from = "cmd:..." } }.'],
  [
    "BodylessRequestPolicy",
    'Migrate to match.body { format = "none" } or EmptyBody in expect.',
  ],
  [
    "JsonRequestPolicy",
    'Migrate to match.body { format = "json" } and expect.',
  ],
  ["TaggedUnionGuard", "Migrate to UnionShape in expect."],
  [
    "anthropicV1",
    'Migrate to scopes { ["anthropic"] = presets.anthropic.v1 }.',
  ],
  [
    "anthropicJsonPolicy",
    "presets are now named scope declarations, not functions. Use presets.anthropic.v1.",
  ],
  ["MaskValueConfig", "Migrate to the secrets registry."],
  [
    "pendingDefaultScope",
    "Removed. The approval scope is derived from the specificity of the matched rule.",
  ],
];

const MIGRATION_GUIDE_URL =
  "https://github.com/Hogeyama/nix-agent-sandbox/blob/main/docs/migration/network-scopes.md#legacy-identifier-mapping";

/**
 * 評価前の生ソースから廃止した識別子を探す。
 *
 * 探しているのは**参照**であって、その綴りの文字列ではない。この走査があるのは
 * Pkl の `Unresolved reference` が移行先を教えてくれないからであり、パスや
 * ホスト名にたまたま旧名と同じ語が現れる設定や、移行の注意書きに旧名を書いた
 * 設定を起動不能にすることは目的ではない。名前が参照になりえない範囲 —
 * コメントと文字列リテラル — は先に伏せてから走査する。
 */
export function detectLegacyIdentifiers(
  source: string,
  fileName: string,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = maskNonCode(source).split("\n");
  for (const [index, line] of lines.entries()) {
    for (const [identifier, migration] of LEGACY_IDENTIFIERS) {
      if (!containsIdentifier(line, identifier)) continue;
      diagnostics.push(
        error(
          [
            `config error: ${fileName}:${index + 1} references the removed \`${identifier}\`.`,
            `            ${migration}`,
            `            Mapping table: ${MIGRATION_GUIDE_URL}`,
          ].join("\n"),
        ),
      );
    }
  }
  return diagnostics;
}

// -------------------------------------------------------------------- 補助

export function effectiveAudit(
  defaults: AuditMode | undefined,
  scope: AuditMode | undefined,
  rule: AuditMode | undefined,
): AuditMode {
  return rule ?? scope ?? defaults ?? DEFAULT_AUDIT_MODE;
}

/** スコープの `fallback` から生じた確認に使う擬似ルール ID。 */
export function fallbackRuleId(scopeName: string): string {
  return `${scopeName}.${FALLBACK_RULE_KEY}`;
}

function error(message: string): Diagnostic {
  return { severity: "error", message };
}

function warning(message: string): Diagnostic {
  return { severity: "warning", message };
}
