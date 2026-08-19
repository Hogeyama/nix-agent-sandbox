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
  parseInjectValue,
  type ResolvedLimits,
  RULE_KEY_PATTERN,
  type RuleConfig,
  requiresJsonBody,
  type ScopeConfig,
  type SecretDisposition,
} from "./config.ts";
import { parsePathPattern } from "./pattern.ts";
import {
  type CompiledMatch,
  compileMatch,
  KNOWN_HTTP_METHODS,
  matchesIntersect,
  matchSubsumes,
  normalizeMethod,
  parseTarget,
  targetSetsIntersect,
} from "./relation.ts";
import {
  compareSpecificity,
  compareTargetSpecificity,
  precedenceOrder,
} from "./specificity.ts";
import type { Target } from "./types.ts";
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
    diagnostics.push(error(`スコープ ${name} の targets が空です。`));
  }
  const targets: Target[] = [];
  for (const source of config.targets) {
    const parsed = parseTarget(source);
    if (!parsed.ok) {
      diagnostics.push(
        error(`スコープ ${name} の targets が不正です: ${parsed.error}`),
      );
      continue;
    }
    targets.push(parsed.value);
  }

  const scopeLimits = checkLimits(
    diagnostics,
    config.limits,
    `スコープ ${name}`,
    context.limits,
  );

  const dispositions = mergeDispositions(context.dispositions, config.secrets);
  const rules: CompiledRule[] = [];
  const seenInjectFaults = new Set<string>();

  checkInjects(
    diagnostics,
    seenInjectFaults,
    `スコープ ${name}`,
    config.inject ?? [],
    dispositions,
    context.secrets,
  );

  for (const [key, ruleConfig] of Object.entries(config.rules ?? {})) {
    const id = `${name}.${key}`;
    if (!RULE_KEY_PATTERN.test(key)) {
      diagnostics.push(
        error(
          `スコープ ${name} のルールのキー ${JSON.stringify(key)} が [a-z][a-z0-9._-]{0,63} に反します。`,
        ),
      );
      continue;
    }
    checkLimits(diagnostics, ruleConfig.limits, `ルール ${id}`, scopeLimits);
    const ruleDispositions = mergeDispositions(
      dispositions,
      ruleConfig.secrets,
    );
    checkInjects(
      diagnostics,
      seenInjectFaults,
      `ルール ${id}`,
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
      diagnostics.push(error(`ルール ${id} のパスパターン: ${parsed.error}`));
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
        `ルール ${id} の paths が空です。受理集合が空になり、このルールは決して発火しません。`,
      ),
    );
    broken = true;
  }

  for (const [name, values] of Object.entries(rule.match.captures ?? {})) {
    if (!captureNames.has(name)) {
      diagnostics.push(
        error(
          `ルール ${id} の captures が、どのパスパターンにも現れない名前 ${name} を制約しています。`,
        ),
      );
      continue;
    }
    if (values.length === 0) {
      diagnostics.push(
        error(
          `ルール ${id} の captures の ${name} が空の Listing です。受理集合が空になり、このルールは決して発火しません。`,
        ),
      );
    }
  }

  checkMethods(diagnostics, id, rule.match.methods);
  broken = checkBodyMatch(diagnostics, id, rule.match.body) || broken;

  if (broken) return null;
  const compiled = compileMatch(rule.match);
  if (!compiled.ok) {
    diagnostics.push(error(`ルール ${id} の match: ${compiled.error}`));
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
  if (body.format !== "json" && Object.keys(body.equals ?? {}).length > 0) {
    diagnostics.push(
      error(
        `ルール ${id} の match.body.format = "${body.format}" に equals を併記できません。値条件は format = "json" を要します。`,
      ),
    );
    broken = true;
  }
  if (body.format !== "json" && Object.keys(body.oneOf ?? {}).length > 0) {
    diagnostics.push(
      error(
        `ルール ${id} の match.body.format = "${body.format}" に oneOf を併記できません。値条件は format = "json" を要します。`,
      ),
    );
    broken = true;
  }

  for (const [pointer, value] of Object.entries(body.equals ?? {})) {
    if (!isValidJsonPointer(pointer)) {
      diagnostics.push(
        error(
          `ルール ${id} の match.body.equals の ${pointer} は RFC 6901 JSON Pointer として不正です。`,
        ),
      );
      broken = true;
    }
    if (isFiniteJsonScalar(value)) continue;
    diagnostics.push(
      error(
        `ルール ${id} の match.body.equals の ${pointer} は文字列・有限な数値・真偽値のいずれかである必要があります。`,
      ),
    );
    broken = true;
  }
  for (const [pointer, values] of Object.entries(body.oneOf ?? {})) {
    if (!isValidJsonPointer(pointer)) {
      diagnostics.push(
        error(
          `ルール ${id} の match.body.oneOf の ${pointer} は RFC 6901 JSON Pointer として不正です。`,
        ),
      );
      broken = true;
    }
    if (values.length === 0) {
      diagnostics.push(
        error(
          `ルール ${id} の match.body.oneOf の ${pointer} が空の Listing です。受理集合が空になり、このルールは決して発火しません。`,
        ),
      );
      broken = true;
    }
    for (const value of values as readonly unknown[]) {
      if (isFiniteJsonScalar(value)) continue;
      diagnostics.push(
        error(
          `ルール ${id} の match.body.oneOf の ${pointer} は文字列・有限な数値・真偽値のみを持つ必要があります。`,
        ),
      );
      broken = true;
    }
  }
  return broken;
}

function isValidJsonPointer(pointer: string): boolean {
  return (
    pointer === "" || (pointer.startsWith("/") && !/~(?![01])/u.test(pointer))
  );
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
        `ルール ${id} の match.methods にある ${JSON.stringify(method)} は既知の HTTP メソッドではありません。` +
          ` 綴りが違えばこのルールは決して発火しません。`,
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
          `ルール ${id} の expect[${index}] (${expect.kind}) は match.body.format = "json" を要します。`,
        ),
      );
    }
    checkEmptyExpectListings(diagnostics, id, index, expect);
  }

  if (!expects.some((expect) => expect.onViolation === "allow")) return;
  if (audit !== "always") {
    diagnostics.push(
      error(
        `ルール ${id} は onViolation = "allow" を持つので audit = "always" が要ります。` +
          ` 記録なしで違反を通過させる設定は禁じられています。`,
      ),
    );
  }
}

function checkEmptyExpectListings(
  diagnostics: Diagnostic[],
  id: string,
  index: number,
  expect: Expect,
): void {
  const where = `ルール ${id} の expect[${index}]`;
  if (expect.kind === "unionShape") {
    if (expect.allowed.length === 0) {
      diagnostics.push(
        error(`${where} の allowed が空の Listing です。常に違反になります。`),
      );
    }
    return;
  }
  if (expect.kind !== "body") return;

  for (const [pointer, values] of Object.entries(expect.oneOf ?? {})) {
    if (values.length === 0) {
      diagnostics.push(
        error(
          `${where} の oneOf の ${pointer} が空の Listing です。受理集合が空になり、この条件は決して満たされません。`,
        ),
      );
    }
  }
  const graphql = expect.graphql;
  if (graphql === undefined) return;
  if (graphql.operations.length === 0) {
    diagnostics.push(
      error(
        `${where} の graphql.operations が空の Listing です。受理集合が空になり、この条件は決して満たされません。`,
      ),
    );
  }
  if (graphql.rootFields !== undefined && graphql.rootFields.length === 0) {
    diagnostics.push(
      error(
        `${where} の graphql.rootFields が空の Listing です。受理集合が空になり、この条件は決して満たされません。`,
      ),
    );
  }
  for (const [name, values] of Object.entries(graphql.arguments ?? {})) {
    if (values.length === 0) {
      diagnostics.push(
        error(
          `${where} の graphql.arguments の ${name} が空の Listing です。受理集合が空になり、この条件は決して満たされません。`,
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
          `${where} の limits.${key} = ${value} が継承した天井 ${inherited[key]} を上回っています。予算は下げる方向にしか変えられません。`,
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
          error(`${where} の inject のヘッダー ${entry.name}: ${parsed.error}`),
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
              `${where} の inject が secrets レジストリに存在しない名前 ${name} を参照しています。`,
            ),
          );
        }
        continue;
      }
      if (expandsToMultipleValues(secret)) {
        if (once(seen, `multi:${name}`)) {
          diagnostics.push(
            error(
              `${where} の inject が複数の値に展開される秘密 ${name} (${secret.from}) を参照しています。注入は単一の値を要します。`,
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
            `${where} の inject が参照する秘密 ${name} の扱いが実効値で "${disposition}" です。inject から参照するには "inject" である必要があります。`,
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
            `スコープ ${scope.name} が秘密の扱いに "${disposition}" を持つので mask.proxy = false を選べません。` +
              ` プロキシでのマスクを行わないなら network.defaults.secrets { ["*"] = "ignore" } を明示してください。`,
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
        `設定エラー: スコープ ${a.name} と ${b.name} のターゲット集合が一致します。`,
        "            同一ホストを 2 つのスコープに分割することはできません。",
        "            ホストの中の書き分けは 1 つのスコープ内のルールで表現してください。",
        "",
      ]
    : [
        `設定エラー: スコープ ${a.name} と ${b.name} のターゲット集合が交差します。`,
        "            どちらも他方を包含しないため、どちらを適用するか決まりません。",
        "",
      ];
  if (witness !== null) {
    lines.push(
      "  両方に属するターゲットの例:",
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
    "  解決方法:",
    ...(equivalent
      ? ["    - 2 つのスコープを 1 つにまとめ、書き分けをルールで表現する"]
      : [
          "    - どちらかの targets をポートまで揃える",
          "    - 一方の targets を他方に包含される形に狭める",
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
        detail: `ルール ${JSON.stringify(rule.key)}`,
      });
    }
  }
  return declarations;
}

function describeIdCollision(a: IdDeclaration, b: IdDeclaration): string {
  return [
    `設定エラー: 2 つの宣言が同じ実 ID ${a.id} を作ります。`,
    "            承認も監査もルールを実 ID で指すので、どちらの宣言に対する",
    "            答えなのかが決まりません。一方に向けて押された承認が、",
    "            もう一方のリクエストまで通してしまいます。",
    "",
    ...alignedRows([
      [`スコープ ${a.scopeName}`, a.detail],
      [`スコープ ${b.scopeName}`, b.detail],
    ]),
    "",
    "  解決方法:",
    "    - どちらかのルールのキーを変える",
    "    - どちらかのスコープ名を変える",
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
    `設定エラー: スコープ ${scope.name} のルールの優先関係が循環しています。`,
    `            ${ring}`,
    "            どのルールを先に評価するか決まりません。特異度による選択が",
    "            スコープ全体で成り立たなくなります。",
    "",
    "  循環を作っている優先:",
    ...edges.map((line) => `    ${line}`),
    "",
    "  解決方法:",
    "    - 優先の向きが 1 つに決まるよう、片側の overrides を消す",
    "    - どちらかの match を狭めて overrides を不要にする",
    "    - 交差部分を担当する第 3 のルールを足す",
  ].join("\n");
}

function describePrecedenceEdge(a: CompiledRule, b: CompiledRule): string {
  if ((a.config.overrides ?? []).includes(b.key)) {
    return `${a.id} は overrides { ${JSON.stringify(b.key)} } で ${b.id} より先`;
  }
  return `${a.id} は ${b.id} より特異なので先`;
}

function describeRuleConflict(a: CompiledRule, b: CompiledRule): string {
  const witness = matchIntersectionWitness(a.match, b.match);
  const lines = [
    `設定エラー: ルール ${a.id} と ${b.id} の受理集合が交差します。`,
    "            どちらも他方を包含しないため、どちらを適用するか決まりません。",
    "",
  ];
  if (witness !== null) {
    lines.push(
      "  両方に一致するリクエストの例:",
      ...describeRequest(witness).map((line) => `    ${line}`),
      "",
    );
  }
  lines.push(
    ...alignedRows([
      [a.id, describeMethods(a), a.config.match.paths.join(" ")],
      [b.id, describeMethods(b), b.config.match.paths.join(" ")],
    ]),
    "",
    "  解決方法:",
    `    - ${b.id} に overrides { ${JSON.stringify(a.key)} } を書く`,
    "    - どちらかの match を狭める",
    "    - 交差部分を担当する第 3 のルールを足す",
  );
  return lines.join("\n");
}

function describeMethods(rule: CompiledRule): string {
  const methods = rule.config.match.methods;
  return methods === undefined || methods.length === 0
    ? "(全メソッド)"
    : methods.join("|");
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
          error(`ルール ${rule.id} の overrides が自分自身を指しています。`),
        );
        continue;
      }
      const other = byKey.get(key);
      if (other === undefined) {
        diagnostics.push(
          error(
            `ルール ${rule.id} の overrides が存在しないルール ${scope.name}.${key} を指しています。`,
          ),
        );
        continue;
      }
      if (!matchesIntersect(rule.match, other.match)) {
        diagnostics.push(
          error(
            `ルール ${rule.id} の overrides が受理集合の交差しない相手 ${other.id} を指しています。優先を述べる意味がありません。`,
          ),
        );
      }
    }
  }
  if (total > scope.rules.length && scope.rules.length > 0) {
    diagnostics.push(
      warning(
        `スコープ ${scope.name} の overrides の総数 (${total}) がルール数 (${scope.rules.length}) を超えています。` +
          ` 特異度による選択が手書きの優先順位に退化しかけています。`,
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
          `ルール ${narrow.id} のボディ条件は、同一スコープのより広い無条件 allow ルール ${wide.id} に覆われています。` +
            ` 条件を外れたリクエストは ${wide.id} が拾って通すので、意図が制限であれば条件を match ではなく expect に置いてください。`,
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
  ["reviewRules", "network.scopes に移行してください。"],
  ["ReviewRule", "Scope と Rule に移行してください。"],
  ["credentials", "secrets レジストリとスコープの inject に移行してください。"],
  [
    "CredentialRule",
    "スコープまたはルールの inject に移行してください。マッチャは match が持ちます。",
  ],
  [
    "CredentialValSpec",
    'secrets { [name] { from = "cmd:..." } } に移行してください。',
  ],
  [
    "BodylessRequestPolicy",
    'match.body { format = "none" } または expect の EmptyBody に移行してください。',
  ],
  [
    "JsonRequestPolicy",
    'match.body { format = "json" } と expect に移行してください。',
  ],
  ["TaggedUnionGuard", "expect の UnionShape に移行してください。"],
  [
    "anthropicV1",
    'scopes { ["anthropic"] = presets.anthropic.v1 } に移行してください。',
  ],
  [
    "anthropicJsonPolicy",
    "preset は関数ではなく名前付きのスコープ宣言になりました。presets.anthropic.v1 を使ってください。",
  ],
  ["MaskValueConfig", "secrets レジストリに移行してください。"],
  [
    "pendingDefaultScope",
    "廃止されました。承認スコープはマッチしたルールの具体性から導出されます。",
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
            `設定エラー: ${fileName}:${index + 1} で廃止された \`${identifier}\` を参照しています。`,
            `            ${migration}`,
            `            対応表: ${MIGRATION_GUIDE_URL}`,
          ].join("\n"),
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * 名前が参照になりえない範囲を空白で塗り潰す。改行は残すので行番号は変わらない。
 *
 * 伏せるのはコメント (行・ブロック) と文字列リテラルの中身である。Pkl の文字列は
 * `"..."` と複数行の `"""..."""`、およびそれぞれをポンド記号で囲む
 * `#"..."#` の形を取る。ポンドの本数はエスケープと閉じ記号の綴りを変えるので、
 * 開いたときの本数を覚えておいて突き合わせる。
 *
 * 文字列の中の `\(...)` は補間であり、その中は式である。つまり旧名がそこに
 * 現れれば本物の参照なので、補間の中はコードとして扱う。
 *
 * 閉じない引用符は行末で打ち切る。打ち切らないと、引用符 1 つの書き損じで
 * ファイルの残り全部が伏せられ、この検査が黙って無効になる。
 */
function maskNonCode(source: string): string {
  type Frame =
    | { readonly kind: "string"; readonly pounds: number; multiline: boolean }
    | { kind: "interpolation"; depth: number };

  const out: string[] = [];
  const stack: Frame[] = [];
  let at = 0;
  const keep = (length: number): void => {
    out.push(source.slice(at, at + length));
    at += length;
  };
  const hide = (length: number): void => {
    for (const char of source.slice(at, at + length)) {
      out.push(char === "\n" ? "\n" : " ");
    }
    at += length;
  };

  while (at < source.length) {
    const top = stack[stack.length - 1];

    if (top === undefined || top.kind === "interpolation") {
      if (source.startsWith("//", at)) {
        const end = source.indexOf("\n", at);
        hide((end === -1 ? source.length : end) - at);
        continue;
      }
      if (source.startsWith("/*", at)) {
        const end = source.indexOf("*/", at + 2);
        hide((end === -1 ? source.length : end + 2) - at);
        continue;
      }
      const opener = stringOpener(source, at);
      if (opener !== null) {
        stack.push({
          kind: "string",
          pounds: opener.pounds,
          multiline: opener.multiline,
        });
        hide(opener.length);
        continue;
      }
      if (top !== undefined) {
        // 補間の中の括弧を数える。釣り合った時点で文字列に戻る。
        const char = source[at];
        if (char === "(") top.depth++;
        else if (char === ")") {
          if (top.depth === 0) {
            stack.pop();
            keep(1);
            continue;
          }
          top.depth--;
        }
      }
      keep(1);
      continue;
    }

    const escapePrefix = `\\${"#".repeat(top.pounds)}`;
    if (source.startsWith(escapePrefix, at)) {
      if (source[at + escapePrefix.length] === "(") {
        stack.push({ kind: "interpolation", depth: 0 });
        hide(escapePrefix.length + 1);
        continue;
      }
      hide(Math.min(escapePrefix.length + 1, source.length - at));
      continue;
    }
    const closer = `${top.multiline ? '"""' : '"'}${"#".repeat(top.pounds)}`;
    if (source.startsWith(closer, at)) {
      stack.pop();
      hide(closer.length);
      continue;
    }
    if (!top.multiline && source[at] === "\n") {
      stack.pop();
      keep(1);
      continue;
    }
    hide(1);
  }
  return out.join("");
}

/** その位置が文字列の開き記号なら、その本数と長さを返す。 */
function stringOpener(
  source: string,
  at: number,
): { pounds: number; multiline: boolean; length: number } | null {
  let pounds = 0;
  while (source[at + pounds] === "#") pounds++;
  if (source[at + pounds] !== '"') return null;
  const multiline = source.startsWith('"""', at + pounds);
  return { pounds, multiline, length: pounds + (multiline ? 3 : 1) };
}

function containsIdentifier(line: string, identifier: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(identifier, from);
    if (at === -1) return false;
    const before = line[at - 1];
    const after = line[at + identifier.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
    from = at + 1;
  }
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
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
