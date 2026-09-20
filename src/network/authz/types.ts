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
  /**
   * 取得を許す**末端**フィールドの経路。必須・非空。
   *
   * `/` 始まりで、各要素は GraphQL の Name (`[_A-Za-z][_0-9A-Za-z]*`)。
   * JSON Pointer ではないので escape も index も持たず、alias と型条件も含まない
   * (`graphql_selection.ts` の `isGraphqlFieldPath`)。子を持つ field はここに
   * 挙げた経路の真の接頭辞でなければならず、子を持たない field は完全一致を
   * 要する。`*` / `**` は無い。経路を制約しない GraphQL 条件は提供しない。
   */
  readonly fieldPaths: readonly string[];
  /**
   * 経路ごとの必須引数。「フィールド経路 → 引数名 → 許す文字列」。省略時は
   * 制約しない。キーは許可末端かその途中の経路でなければならない。
   *
   * その経路の field が現れたとき、名指しした引数が**その出現に存在し**、解決後の
   * 文字列が集合に含まれることを要求する。field 自体の出現は要求しない。変数参照の
   * 引数は兄弟の `variables` (無いか null ならその出現を含む operation の既定値) で
   * 解決し、`variables` がオブジェクトでも null でもなければ解決できない (規則は
   * `graphql.ts` の `resolveArgumentValue`)。
   */
  readonly fieldArguments?: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
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
 * GraphQL document 中の field の 1 つの出現 (fragment を使用位置で展開した後)。
 *
 * 同じ経路の出現もまとめずに 1 件ずつ持つ。引数は出現ごと・その出現を含む
 * operation の文脈 (変数の既定値) で解決する。
 */
export interface GraphqlFieldOccurrence {
  /**
   * operation の root からの field 名の経路 (`/repository/issues/nodes`)。
   * alias・型条件・fragment 名は含まない。
   */
  readonly path: string;
  /** 子の selection set を持たない field か。 */
  readonly leaf: boolean;
  /** この出現で文字列に解決できた引数 (引数名 → 値)。 */
  readonly argumentValues: Readonly<Record<string, string>>;
  /** この出現で文字列に解決できなかった引数名 (記述順)。 */
  readonly unresolvedArguments: readonly string[];
}

/**
 * GraphQL document から判定に必要な事実だけを取り出したもの。
 *
 * `operations` と `fields` は空にならない。実行可能な document は最低 1 つの
 * operation を持ち、selection set は空にならないので末端の field を最低 1 つ
 * 持つ。`fields` は operation の定義順、各 selection の記述順の深さ優先
 * (親が子より先) に並ぶ。
 */
export interface GraphqlDocument {
  readonly operations: readonly GraphqlOperation[];
  readonly fields: readonly GraphqlFieldOccurrence[];
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
