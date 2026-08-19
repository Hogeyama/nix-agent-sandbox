/**
 * ネットワーク認可 config の静的解析が扱う語彙。
 *
 * 設計: docs/superpowers/specs/2026-08-06-network-authorization-config-model-design.md
 * 「Match の語彙」「選択規則」に対応する。ここは型だけを置き、判定は
 * pattern.ts / relation.ts / specificity.ts / witness.ts に置く。
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type JsonScalar = string | number | boolean;

export type JsonValue =
  | JsonScalar
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type GraphqlOperation = "query" | "mutation" | "subscription";

export type BodyFormat = "none" | "json" | "opaque";

/** `GraphqlMatch.at` の既定値。 */
export const DEFAULT_GRAPHQL_AT = "/query";

export interface GraphqlMatch {
  /** document を運ぶフィールド。省略時は `/query`。 */
  readonly at?: string;
  /** 許す operation の種別。 */
  readonly operations: readonly GraphqlOperation[];
  /** 許す root field 名。省略時は制約しない。 */
  readonly rootFields?: readonly string[];
  /** 引数名ごとに許す文字列リテラルの集合。省略時は制約しない。 */
  readonly arguments?: Readonly<Record<string, readonly string[]>>;
}

export interface BodyMatch {
  readonly format: BodyFormat;
  readonly equals?: Readonly<Record<string, JsonScalar>>;
  readonly oneOf?: Readonly<Record<string, readonly JsonScalar[]>>;
  readonly graphql?: GraphqlMatch;
}

export interface Match {
  /** 省略時は全メソッドに一致する。 */
  readonly methods?: readonly string[];
  readonly paths: readonly string[];
  readonly captures?: Readonly<Record<string, readonly string[]>>;
  readonly body?: BodyMatch;
}

/**
 * リクエストのモデル。
 *
 * ボディは生バイト列ではなく、判定に効く状態だけを持つ。段階 0 は JSON パーサも
 * GraphQL パーサも作らないので、解析済みの事実を直接与える形にしてある。
 * 実際のバイト列からこの形を作るのは段階 1 以降の仕事である。
 */
export interface AuthzRequest {
  readonly method: string;
  readonly path: string;
  readonly body: RequestBody;
}

export type RequestBody =
  /** ボディが存在しない (GET など)。 */
  | { readonly kind: "absent" }
  /** ボディが存在し、長さが 0 である。 */
  | { readonly kind: "empty" }
  /** ボディが存在し、JSON として解析できない。 */
  | { readonly kind: "binary" }
  /** ボディが存在し、JSON として解析できる。 */
  | {
      readonly kind: "json";
      readonly value: JsonValue;
      /**
       * JSON Pointer → その位置にある GraphQL document の解析結果。
       * ここに現れる Pointer の値は `value` 側でも文字列でなければならない。
       */
      readonly documents?: Readonly<Record<string, GraphqlDocument>>;
    };

/**
 * GraphQL document から判定に必要な事実だけを取り出したもの。
 *
 * `operations` と `rootFields` は空にならない。実行可能な document は
 * 最低 1 つの operation を持ち、operation は最低 1 つの root field を持つ。
 * この前提が `operations` / `rootFields` の互いに素な集合を「交差しない」と
 * 結論してよい根拠になっている (relation.ts を参照)。
 */
export interface GraphqlDocument {
  readonly operations: readonly GraphqlOperation[];
  readonly rootFields: readonly string[];
  /** 引数名 → document 中に現れたその引数の値の全体。 */
  readonly argumentValues: Readonly<Record<string, readonly string[]>>;
}

export type HostPattern =
  | { readonly kind: "exact"; readonly host: string }
  | { readonly kind: "suffix"; readonly suffix: string };

export interface Target {
  readonly source: string;
  readonly host: HostPattern;
  /** null は全ポート。 */
  readonly port: number | null;
}

export interface TargetAddress {
  readonly host: string;
  readonly port: number;
}
