/**
 * GraphQL document から判定用の facts を取り出す参照実装。
 *
 * `RequestBody.documents` を組む道具であり、production の経路
 * (resolve / broker / stages) からは import しない。実行時の解析は addon 側の
 * graphql-core が担い、こちらはパリティ試験と単体テストのための写しである。
 * 両側が同じ答えを出せるよう、抽出規則は AST のノード種別に依存しない形で
 * 固定してある。
 *
 * 「解析できない」(null) になるのは次のいずれかのときである。壊れた
 * document、GraphQL でない文字列と同じ扱いで、match では判定不能、expect
 * では違反になる。
 *
 * - `parse` が失敗する (構文エラー)
 * - token 数が `limits.maxNodes` を超える (`maxTokens` による parse 失敗)
 * - 深さが `limits.maxDepth` を超える
 * - operation を 1 つも持たない (fragment のみ)
 * - 同じ名前の fragment を 2 度定義する
 * - 1 つの operation が同じ名前の変数を 2 度宣言する
 * - 未定義の fragment 名を spread する、または spread が循環する
 * - 全 operation から fragment を使用位置で展開した量が `limits.maxNodes` を
 *   超える、または展開後の field の入れ子が `limits.maxDepth` を超える
 *   (`collectSelectionFacts` を参照)
 * - 到達する operation・変数定義・field・fragment に `@skip` / `@include`
 *   以外の directive がある
 * - 到達する 1 つの field が同じ名前の引数を 2 度持つ
 *
 * 深さは `SelectionSet` / `ListValue` / `ObjectValue` の入れ子の最大段数とし、
 * document 直下を 0 とする。この 3 種は graphql-js と graphql-core の AST に
 * 同じ形で存在するので、他のノード種別を挟んでいても段数は継続して数える。
 * `query { a { b } }` は SelectionSet が 2 段で深さ 2、
 * `{ f(x: {a: [1]}) }` は SelectionSet・ObjectValue・ListValue で深さ 3 である。
 */

import {
  type ASTNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionNode,
  type ValueNode,
  visit,
} from "graphql";
import { resolvePointer } from "./semantics.ts";
import type {
  GraphqlDocument,
  GraphqlFieldOccurrence,
  GraphqlOperation,
  JsonValue,
} from "./types.ts";

export interface GraphqlParseLimits {
  /** 解析に使う token 数の天井 (`maxNodes` の GraphQL 版)。 */
  readonly maxNodes: number;
  /** SelectionSet / ListValue / ObjectValue の入れ子の天井。 */
  readonly maxDepth: number;
}

/**
 * document 文字列から facts を取り出す。取り出せなければ null。
 *
 * `variables` は `$v` の解決に使う JSON 値 (通常はリクエストオブジェクトの
 * `variables` メンバ)。undefined はメンバが無いこと、null は JSON の null を
 * 表す。どちらか、またはキー `v` を持たないオブジェクトなら、その出現を含む
 * operation が宣言する既定値を使う。オブジェクトでない `variables` の下の
 * 変数と、値が文字列にならない変数は、その出現の `unresolvedArguments` に
 * 載る (規則は `resolveArgumentValue`)。
 */
export function parseGraphqlFacts(
  text: string,
  limits: GraphqlParseLimits,
  variables?: JsonValue,
): GraphqlDocument | null {
  let document: DocumentNode;
  try {
    document = parse(text, { maxTokens: limits.maxNodes });
  } catch {
    return null;
  }
  if (measureDepth(document) > limits.maxDepth) return null;

  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: GraphqlOperation[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      // 名前のない省略形 `{ ... }` はパーサが `query` の definition として返す。
      operations.push(definition.operation);
      // 同名の変数の宣言は GraphQL として不正 (UniqueVariableNames) であり、
      // 既定値をどちらの宣言から取るかは実装によって割れる (検証しない
      // graphql-js の実行は後の宣言を使う)。検査側で決められないので解析
      // できない。
      if (declaresVariableTwice(definition)) return null;
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      // 同名の fragment は GraphQL として不正 (UniqueFragmentNames) であり、
      // どちらの定義が使われるかを検査側で決められないので解析できない。
      if (fragments.has(definition.name.value)) return null;
      fragments.set(definition.name.value, definition);
    }
  }
  // operation を持たない document はサーバで実行できない。検査ゲートが黙って
  // 通す理由がないので「解析できない」とする。
  if (operations.length === 0) return null;
  if (!spreadsAreValid(document, fragments)) return null;
  const fields = collectSelectionFacts(document, fragments, variables, limits);
  if (fields === null) return null;

  return { operations: [...new Set(operations)], fields };
}

/**
 * `value` の `ats` にある文字列を document として facts に変換し、
 * `RequestBody.documents` の形で返す。
 *
 * `at` の対象が文字列でない、または facts が取れない位置には項目を作らない。
 * 載らなかった `at` は `semantics.ts` の規則 (対象が無ければ偽、あるのに
 * 読めなければ判定不能) がそのまま正しく効く。
 */
export function buildGraphqlDocuments(
  value: JsonValue,
  ats: readonly string[],
  limits: GraphqlParseLimits,
): Readonly<Record<string, GraphqlDocument>> {
  const documents: Record<string, GraphqlDocument> = {};
  for (const at of ats) {
    const target = resolvePointer(value, at);
    if (typeof target !== "string") continue;
    const facts = parseGraphqlFacts(target, limits, variablesFor(value, at));
    if (facts !== null) documents[at] = facts;
  }
  return documents;
}

/**
 * `at` の指す document を運ぶリクエストオブジェクトの `variables` メンバを
 * 返す。document は GraphQL-over-HTTP の `{query, variables, ...}` 形の一員
 * なので、変数は `at` と同じオブジェクトの兄弟メンバにある。`at` がルート
 * (document そのものがボディ) のときは兄弟が存在せず、変数は無い。
 * メンバが無いときは undefined、JSON の null のときは null を返し、両者を
 * 区別したまま `parseGraphqlFacts` に渡す。
 */
function variablesFor(root: JsonValue, at: string): JsonValue | undefined {
  if (at === "" || !at.startsWith("/")) return undefined;
  const parent = at.slice(0, at.lastIndexOf("/"));
  return resolvePointer(root, `${parent}/variables`);
}

function measureDepth(document: DocumentNode): number {
  let depth = 0;
  let deepest = 0;
  visit(document, {
    enter(node) {
      if (isDepthNode(node)) {
        depth += 1;
        if (depth > deepest) deepest = depth;
      }
    },
    leave(node) {
      if (isDepthNode(node)) depth -= 1;
    },
  });
  return deepest;
}

function isDepthNode(node: ASTNode): boolean {
  return (
    node.kind === Kind.SELECTION_SET ||
    node.kind === Kind.LIST ||
    node.kind === Kind.OBJECT
  );
}

/**
 * すべての fragment spread が定義済みで、spread の依存に循環が無いかを見る。
 * 未定義・循環はどちらもサーバで実行できない document なので「解析できない」。
 */
function spreadsAreValid(
  document: DocumentNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): boolean {
  for (const name of spreadNames(document)) {
    if (!fragments.has(name)) return false;
  }

  const adjacency = new Map<string, readonly string[]>();
  for (const [name, fragment] of fragments) {
    adjacency.set(name, spreadNames(fragment));
  }
  // 白灰黒の DFS で閉路を検出する。反復にしておくと fragment の連鎖が
  // 深い document でもコールスタックを使わない。
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const stack: [string, number][] = [];
  for (const root of fragments.keys()) {
    if (state.get(root) === DONE) continue;
    state.set(root, VISITING);
    stack.push([root, 0]);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as [string, number];
      const edges = adjacency.get(frame[0]) ?? [];
      if (frame[1] >= edges.length) {
        state.set(frame[0], DONE);
        stack.pop();
        continue;
      }
      const next = edges[frame[1]] as string;
      frame[1] += 1;
      const nextState = state.get(next);
      if (nextState === VISITING) return false;
      if (nextState === undefined) {
        state.set(next, VISITING);
        stack.push([next, 0]);
      }
    }
  }
  return true;
}

/** ノード以下に現れるすべての fragment spread の名前 (出現順)。 */
function spreadNames(node: ASTNode): readonly string[] {
  const names: string[] = [];
  visit(node, {
    FragmentSpread(spread) {
      names.push(spread.name.value);
    },
  });
  return names;
}

/** 検査が意味を決められる directive。他は document 全体を解析不能にする。 */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set(["skip", "include"]);

/**
 * 出現 1 件が予算 1 で保持してよい経路のバイト数。`collectSelectionFacts` の
 * 経路課金の単位であり、Python 側の `_GRAPHQL_PATH_CHARGE_UNIT` と同じ値で
 * なければならない (課金が違えば同じ document で片側だけが null になる)。
 * GraphQL の Name は `[_A-Za-z][_0-9A-Za-z]*` の ASCII なので、経路の
 * 文字数 = UTF-16 単位数 = バイト数であり、両側の `length` / `len` は一致する。
 */
const PATH_CHARGE_UNIT = 64;

/**
 * 全 operation の selection を使用位置で展開し、field の出現を 1 件ずつ
 * document 順 (operation の定義順・selection の記述順・親が子より先) で返す。
 * 展開しきれない document は null (解析できない) であり、途中までの出現を
 * 返さない。
 *
 * fragment 名で「展開済み」と扱ってはならない。同じ fragment が別の親の下に
 * 現れれば、その使用位置の経路で改めて検査する必要がある (spec「Alias、
 * fragment、operation」)。循環は `spreadsAreValid` が既に退けてあるので展開は
 * 停止するが、ダイヤモンド状の spread は展開量が入力の大きさに対して指数的に
 * なり得る。そこで予算を持つ。`limits.maxNodes` を document 全体の上限として、
 * 次のそれぞれを 1 として課金する。重複をまとめる前に課金するので、展開が
 * 爆発する document は出現を作り切る前に null になる。
 *
 * - 取り出した selection (field / inline fragment / fragment spread) 1 つ
 * - 走査した directive 1 つ (operation・変数定義・selection・使用される
 *   fragment 定義のいずれに付いていても、到達するたびに)
 * - 評価した引数の出現 1 つ
 * - 出現に載せる経路の `PATH_CHARGE_UNIT` バイト (`floor(len / 64)`)
 *
 * 前半 2 つと後半 2 つは、どちらも「1 課金の裏で任意量の仕事をさせない」
 * ための課金である。ここで課金しないと次が成り立ってしまう:
 * directive は 1 つの visit がいくつでも走査でき、しかも spread で同じ
 * ノードに何度到達しても走査し直す。経路は Name が 1 token でいくら長くも
 * できるので、出現ごとに新しく作る文字列の長さが body の大きさだけで決まる。
 * どちらも小さな body で大量の CPU / メモリを使わせる道になる。
 *
 * この課金が保証する不変条件 (どちらも document 1 件・解析 1 回あたり):
 *
 * - 走査する directive の総数 ≤ `maxNodes`。
 * - 作って保持する経路の総バイト数 ≤ `PATH_CHARGE_UNIT` × `maxNodes`
 *   (出現 1 件の課金は `1 + floor(len/64) ≥ len/64`)。既定値では
 *   200_000 × 64 = 12.8 MB が上限。
 *
 * 展開後の field の入れ子段数にも `limits.maxDepth` を適用する (fragment
 * 越しの深さは token 数や AST の段数では抑えられない)。
 */
function collectSelectionFacts(
  document: DocumentNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variables: JsonValue | undefined,
  limits: GraphqlParseLimits,
): readonly GraphqlFieldOccurrence[] | null {
  interface Frame {
    selections: readonly SelectionNode[];
    index: number;
    /** この selection の親 field までの経路 (root なら空文字列)。 */
    path: string;
    /** 親 field の入れ子段数 (root 直下の field が 1 になる)。 */
    depth: number;
    /** この使用位置を含む operation の変数の既定値。 */
    defaults: VariableDefaults;
  }

  const fields: GraphqlFieldOccurrence[] = [];
  const stack: Frame[] = [];
  let charged = 0;
  /**
   * directive を 1 つずつ課金しながら既知かどうかを見る。false は「未知の
   * directive がある」か「予算超過」で、どちらも文書全体が null なので
   * 呼び出し側は区別しない。
   */
  const chargeDirectives = (
    directives:
      | readonly { readonly name: { readonly value: string } }[]
      | undefined,
  ): boolean => {
    for (const directive of directives ?? []) {
      charged += 1;
      if (charged > limits.maxNodes) return false;
      if (!KNOWN_DIRECTIVES.has(directive.name.value)) return false;
    }
    return true;
  };

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    if (!chargeDirectives(definition.directives)) return null;
    for (const variable of definition.variableDefinitions ?? []) {
      if (!chargeDirectives(variable.directives)) return null;
    }
    stack.push({
      selections: definition.selectionSet.selections,
      index: 0,
      path: "",
      depth: 0,
      defaults: variableDefaults(definition),
    });
  }
  // 反復スタックの先頭から処理するので、document 順に並べるには逆順に積む。
  stack.reverse();

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.index >= frame.selections.length) {
      stack.pop();
      continue;
    }
    const selection = frame.selections[frame.index] as SelectionNode;
    frame.index += 1;
    charged += 1;
    if (charged > limits.maxNodes) return null;
    if (!chargeDirectives(selection.directives)) return null;

    if (selection.kind === Kind.FIELD) {
      const depth = frame.depth + 1;
      if (depth > limits.maxDepth) return null;
      // alias は捨て、実際に取得される field 名だけを経路にする。
      const path = `${frame.path}/${selection.name.value}`;
      // 経路は出現ごとに新しく作る文字列で、そのまま出現に載る。GraphQL の
      // Name はどれだけ長くても 1 token なので、visit 1 件 = 1 課金のままだと
      // 小さな body で巨大な文字列を何万個も作らせることができる。長さに
      // 応じて課金し、保持する経路の総量を予算で縛る (上の不変条件)。
      charged += Math.floor(path.length / PATH_CHARGE_UNIT);
      if (charged > limits.maxNodes) return null;
      const argumentValues = new Map<string, string>();
      const unresolvedArguments: string[] = [];
      // 重複判定は補助の Set で行う (順序を持つ配列/Map への線形走査だと
      // 1 field に N 個の引数がある document が O(N²) になる)。この Set は
      // 出力に載らず、出力順は argumentValues (Map) / unresolvedArguments
      // (配列) それぞれの追加順のまま変わらない。
      const seenArgumentNames = new Set<string>();
      for (const argument of selection.arguments ?? []) {
        charged += 1;
        if (charged > limits.maxNodes) return null;
        const name = argument.name.value;
        // 同じ名前の引数を 2 度持つ field は GraphQL として不正であり
        // (UniqueArgumentNames)、どちらの値で実行されるか検査側で決め
        // られないので解析できない。
        if (seenArgumentNames.has(name)) return null;
        seenArgumentNames.add(name);
        const value = resolveArgumentValue(
          argument.value,
          variables,
          frame.defaults,
        );
        if (value === undefined) unresolvedArguments.push(name);
        else argumentValues.set(name, value);
      }
      fields.push({
        path,
        leaf: selection.selectionSet === undefined,
        // `argumentValues` を Map に集めて `Object.fromEntries` で書き出す
        // ことで、引数名 `__proto__` も他の名前と同様のプレーンな own
        // property になる (`{}` へのブラケット代入だと setter を踏んで
        // 消える)。GraphQL の Name は `__proto__` を含め任意の識別子なので、
        // これはリクエストが制御できる入力である。
        argumentValues: Object.fromEntries(argumentValues),
        unresolvedArguments,
      });
      if (selection.selectionSet !== undefined) {
        stack.push({
          selections: selection.selectionSet.selections,
          index: 0,
          path,
          depth,
          defaults: frame.defaults,
        });
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      // 型条件は経路の要素にならない。スキーマを持たないので、実行され
      // ない分岐だと推測して除外もしない。
      stack.push({
        selections: selection.selectionSet.selections,
        index: 0,
        path: frame.path,
        depth: frame.depth,
        defaults: frame.defaults,
      });
    } else {
      const fragment = fragments.get(selection.name.value);
      // 未定義の spread は `spreadsAreValid` が既に退けてある。
      if (fragment === undefined) return null;
      if (!chargeDirectives(fragment.directives)) return null;
      stack.push({
        selections: fragment.selectionSet.selections,
        index: 0,
        path: frame.path,
        depth: frame.depth,
        defaults: frame.defaults,
      });
    }
  }
  return fields;
}

function declaresVariableTwice(operation: OperationDefinitionNode): boolean {
  const names = new Set<string>();
  for (const definition of operation.variableDefinitions ?? []) {
    const name = definition.variable.name.value;
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

/**
 * 1 つの operation が宣言する変数の既定値 (変数名 → 既定値、既定値の無い
 * 宣言は null)。同じ名前の宣言は `parseGraphqlFacts` が既に退けてある。
 */
type VariableDefaults = ReadonlyMap<string, ValueNode | null>;

function variableDefaults(
  operation: OperationDefinitionNode,
): VariableDefaults {
  const defaults = new Map<string, ValueNode | null>();
  for (const definition of operation.variableDefinitions ?? []) {
    defaults.set(
      definition.variable.name.value,
      definition.defaultValue ?? null,
    );
  }
  return defaults;
}

/**
 * 引数の値を文字列に解決する。文字列リテラルはそのまま。`$v` は
 * `variables` の形で決まる:
 *
 * - 無い (undefined) か JSON の null: operation の宣言する既定値が文字列
 *   リテラルのときその値。
 * - オブジェクト: キー `v` を持てばその値 (文字列のときだけ解決、明示の
 *   null を含め他は解決不能)、持たなければ無い場合と同じく既定値。
 * - それ以外 (文字列・配列・数値・真偽値): 解決不能。既定値は使わない。
 *
 * その他のリテラル (Int / Float / Boolean / Null / Enum / List / Object) と
 * 解決できない変数は解決不能 (undefined) である。
 */
function resolveArgumentValue(
  value: ValueNode,
  variables: JsonValue | undefined,
  defaults: VariableDefaults,
): string | undefined {
  if (value.kind === Kind.STRING) return value.value;
  if (value.kind !== Kind.VARIABLE) return undefined;
  const name = value.name.value;
  if (variables !== undefined && variables !== null) {
    // 文字列・配列・数値・真偽値の `variables` は実装によって扱いが割れる
    // (文字列を JSON として読み直すサーバがある)。どの値で実行されるかを
    // 検査側で決められないので、既定値にも倒さず解決不能とする。
    if (typeof variables !== "object" || Array.isArray(variables)) {
      return undefined;
    }
    if (Object.hasOwn(variables, name)) {
      const provided = (variables as { readonly [key: string]: JsonValue })[
        name
      ];
      return typeof provided === "string" ? provided : undefined;
    }
  }
  const fallback = defaults.get(name);
  return fallback?.kind === Kind.STRING ? fallback.value : undefined;
}
