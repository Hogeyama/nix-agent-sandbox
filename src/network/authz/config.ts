/**
 * スコープ体系のネットワーク認可 config を表す TS 型。
 *
 * 設計: docs/superpowers/specs/2026-08-06-network-authorization-config-model-design.md
 * 「秘密の名前付きレジストリ」「スコープ」「ルール」「受理条件 (Expect)」
 * 「秘密の適用範囲」「注入 (Inject)」「予算」「監査」に対応する。
 *
 * Pkl から評価した値をそのまま受ける形にしてある。Mapping はキーの挿入順が
 * 意味を持つ (特異度で決着しない候補のタイブレーク) ので `Record` で表し、
 * 走査には `Object.entries` の順序を使う。ルールのキーは
 * `[a-z][a-z0-9._-]{0,63}` に従うので整数キーにはならず、挿入順が保たれる。
 *
 * `match.body` は `format` だけを持つ。`equals` / `oneOf` / `graphql` を
 * `match` に置けるようにするのは後の段階であり、この段階では受理条件
 * (`BodyExpect`) の側にだけ現れる。
 */

import type { BodyFormat, GraphqlMatch, JsonScalar, Result } from "./types.ts";

export type Action = "allow" | "review" | "deny";
/** どのスコープにも属さないターゲットの帰結。`allow` は選べない。 */
export type NetworkFallback = "review" | "deny";
export type IndeterminateAction = "review" | "deny";
export type ViolationAction = "deny" | "review" | "allow";
export type SecretDisposition = "inject" | "mask" | "forbid" | "ignore";
export type AuditMode = "always" | "aggregate" | "off";

/** ルールのキーの構文。実 ID は `<スコープ名>.<キー>` になる。 */
export const RULE_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * スコープの `fallback` から生じた確認に使う擬似ルール ID の末尾。
 * `$` はルールのキー構文に含まれないので、ユーザーが書いた ID と衝突しない。
 */
export const FALLBACK_RULE_KEY = "$fallback";

export interface SecretConfig {
  /**
   * 取得元。`env:VAR` / `file:/path` / `dotenv:/path#KEY` /
   * `keyring:service/account` / `lines:/path` / `cmd:<command>`。
   */
  readonly from: string;
  readonly required?: boolean;
}

export interface MaskConfig {
  readonly maskfs?: boolean;
  readonly filter?: boolean;
  readonly proxy?: boolean;
  readonly apply?: readonly string[];
}

export interface Limits {
  readonly maxBodyBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxSelectorExpansions?: number;
}

export type ResolvedLimits = Required<Limits>;

/**
 * 既定値は同時に固定の天井でもある。設定は下げる方向にしか変えられない。
 */
export const LIMIT_CEILINGS: ResolvedLimits = {
  maxBodyBytes: 33_554_432,
  maxDepth: 64,
  maxNodes: 200_000,
  maxSelectorExpansions: 1_000_000,
};

export const LIMIT_KEYS = [
  "maxBodyBytes",
  "maxDepth",
  "maxNodes",
  "maxSelectorExpansions",
] as const satisfies readonly (keyof Limits)[];

export interface Inject {
  readonly name: string;
  /** `literal:<value>` / `secret:<name>` / `template:<text>`。 */
  readonly value: string;
}

export type ExpectKind = "emptyBody" | "jsonRoot" | "body" | "unionShape";

interface ExpectCommon {
  /** 違反の帰結。`allow` は違反を記録して通過させる。 */
  readonly onViolation?: ViolationAction;
}

export interface EmptyBodyExpect extends ExpectCommon {
  readonly kind: "emptyBody";
}

export interface JsonRootExpect extends ExpectCommon {
  readonly kind: "jsonRoot";
  readonly rootType: "object" | "array";
}

export interface BodyExpect extends ExpectCommon {
  readonly kind: "body";
  readonly equals?: Readonly<Record<string, JsonScalar>>;
  readonly oneOf?: Readonly<Record<string, readonly JsonScalar[]>>;
  readonly graphql?: GraphqlMatch;
}

export interface UnionShapeExpect extends ExpectCommon {
  readonly kind: "unionShape";
  /** 検査対象を選ぶセレクタ。 */
  readonly at: string;
  /** 対象から外す部分木。 */
  readonly exclude?: readonly string[];
  readonly discriminator: string;
  readonly allowed: readonly string[];
}

export type Expect =
  | EmptyBodyExpect
  | JsonRootExpect
  | BodyExpect
  | UnionShapeExpect;

/** JSON ボディを解析できたことを前提にする受理条件か。 */
export function requiresJsonBody(expect: Expect): boolean {
  return expect.kind !== "emptyBody";
}

export interface BodyMatchConfig {
  readonly format: BodyFormat;
}

export interface MatchConfig {
  /** 省略時は全メソッドに一致する。 */
  readonly methods?: readonly string[];
  readonly paths: readonly string[];
  readonly captures?: Readonly<Record<string, readonly string[]>>;
  readonly body?: BodyMatchConfig;
}

export interface RuleConfig {
  readonly match: MatchConfig;
  readonly onMatch: Action;
  /** match のボディ条件が判定不能だったときの帰結。既定は `deny`。 */
  readonly onIndeterminate?: IndeterminateAction;
  readonly expect?: readonly Expect[];
  readonly limits?: Limits;
  readonly secrets?: Readonly<Record<string, SecretDisposition>>;
  readonly inject?: readonly Inject[];
  readonly audit?: AuditMode;
  /** 特異度で比較できない重なりを明示的に解決する。同一スコープ内のキーを指す。 */
  readonly overrides?: readonly string[];
}

export interface ScopeConfig {
  /** ターゲットのパターン。"api.github.com" / "*.gcr.io" / "example.com:8443"。 */
  readonly targets: readonly string[];
  /** このスコープのどのルールも引き受けなかったリクエストの帰結。既定は `deny`。 */
  readonly fallback?: Action;
  readonly limits?: Limits;
  readonly secrets?: Readonly<Record<string, SecretDisposition>>;
  readonly inject?: readonly Inject[];
  readonly audit?: AuditMode;
  readonly rules?: Readonly<Record<string, RuleConfig>>;
}

export interface NetworkDefaults {
  readonly limits?: Limits;
  readonly secrets?: Readonly<Record<string, SecretDisposition>>;
  readonly audit?: AuditMode;
}

export interface NetworkConfig {
  readonly scopes: Readonly<Record<string, ScopeConfig>>;
  /** どのスコープにも属さないターゲットの帰結。既定は `deny`。 */
  readonly fallback?: NetworkFallback;
  readonly defaults?: NetworkDefaults;
}

/** 解決器が要するプロファイルの断片。 */
export interface AuthzConfig {
  /** 秘密の名前付きレジストリ。 */
  readonly secrets?: Readonly<Record<string, SecretConfig>>;
  readonly mask?: MaskConfig;
  readonly network: NetworkConfig;
}

/**
 * `network.defaults.secrets` の初期値。
 *
 * この初期値があるので、`secrets` を何も書かない設定でも全スコープが `mask` を
 * 持つ状態になる。`mask.proxy = false` が設定エラーになるのはこれが理由である。
 */
export const DEFAULT_SECRET_DISPOSITIONS: Readonly<
  Record<string, SecretDisposition>
> = { "*": "mask" };

/** `network.defaults.audit` を書かなかったときの扱い。 */
export const DEFAULT_AUDIT_MODE: AuditMode = "always";

/**
 * 1 つの名前が複数の値に展開される取得元か。
 *
 * マスクと拒否は値の集合に対して働くが、注入は単一の値を要するので、複数値の
 * 秘密を注入に使う設定はエラーにする。
 */
export function expandsToMultipleValues(secret: SecretConfig): boolean {
  return secret.from.startsWith("lines:");
}

export type InjectValue =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "secret"; readonly name: string }
  | {
      readonly kind: "template";
      readonly text: string;
      readonly names: readonly string[];
    };

const TEMPLATE_REFERENCE = /\$\{([^}]*)\}/g;

export function parseInjectValue(value: string): Result<InjectValue> {
  if (value.startsWith("literal:")) {
    return { ok: true, value: { kind: "literal", text: value.slice(8) } };
  }
  if (value.startsWith("secret:")) {
    const name = value.slice(7);
    if (name === "") return { ok: false, error: "secret: の名前が空である" };
    return { ok: true, value: { kind: "secret", name } };
  }
  if (value.startsWith("template:")) {
    const text = value.slice(9);
    const names = [...text.matchAll(TEMPLATE_REFERENCE)].map(
      (found) => found[1] as string,
    );
    return { ok: true, value: { kind: "template", text, names } };
  }
  // 値そのものは載せない。この分岐に落ちる値の典型は、旧 CredentialRule.value が
  // 素の文字列を取っていた頃の書き方をそのまま持ってきた資格情報である。設定を
  // 直すのに必要なのは受け付ける接頭辞の一覧であって、値ではない。
  return {
    ok: false,
    error:
      "注入する値は literal: / secret: / template: のいずれかで始まる必要がある" +
      " (値は秘密を含みうるので表示しない。素の値を書いていたなら literal: を前置する)",
  };
}

/** その注入が参照する秘密の名前。 */
export function injectReferences(value: InjectValue): readonly string[] {
  switch (value.kind) {
    case "literal":
      return [];
    case "secret":
      return [value.name];
    case "template":
      return value.names;
  }
}
