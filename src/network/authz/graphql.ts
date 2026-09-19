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
 * - operation ごとに到達する fragment を展開した量が `limits.maxNodes` を
 *   超える (`fragmentReachers` を参照)
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
import type { GraphqlDocument, GraphqlOperation, JsonValue } from "./types.ts";

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
 * 表す。どちらか、またはキー `v` を持たないオブジェクトなら operation の
 * 宣言する既定値を使う。オブジェクトでない `variables` の下の変数と、値が
 * 文字列にならない変数は解決不能として `unresolvedArguments` に載る (規則は
 * `resolveArgumentValue`)。
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
  const reachers = fragmentReachers(document, fragments, limits.maxNodes);
  if (reachers === null) return null;

  return {
    operations: [...new Set(operations)],
    rootFields: [...collectRootFields(document, fragments)],
    ...collectArguments(document, reachers, variables),
  };
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

/**
 * 各 operation 直下のフィールド名の全体。root の inline fragment と fragment
 * spread は同一 document 内の定義を引いて展開する。root より深い位置の
 * fragment は展開しない (root field 名に関与しないため)。
 *
 * 同じ fragment は高々 1 度展開する。root に同じ fragment が 2 度現れても
 * 得る名前は同じであり、これで連鎖・再帰の展開が有限回で終わることが
 * 保証される (循環は `spreadsAreValid` で既に退けてある)。
 */
function collectRootFields(
  document: DocumentNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): ReadonlySet<string> {
  const fields = new Set<string>();
  const expanded = new Set<string>();
  // document 順を保つため、深さ優先で位置ごとに進める反復イテレーション。
  interface Frame {
    selections: readonly SelectionNode[];
    index: number;
  }
  const stack: Frame[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      stack.push({ selections: definition.selectionSet.selections, index: 0 });
    }
  }
  stack.reverse();
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.index >= frame.selections.length) {
      stack.pop();
      continue;
    }
    const selection = frame.selections[frame.index] as SelectionNode;
    frame.index += 1;
    if (selection.kind === Kind.FIELD) {
      fields.add(selection.name.value);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      stack.push({ selections: selection.selectionSet.selections, index: 0 });
    } else {
      const name = selection.name.value;
      if (expanded.has(name)) continue;
      expanded.add(name);
      const fragment = fragments.get(name);
      if (fragment !== undefined) {
        stack.push({ selections: fragment.selectionSet.selections, index: 0 });
      }
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
 * fragment 名ごとに、その fragment に (spread を推移的に辿って) 到達する
 * operation の変数の既定値を、operation の document 順に並べて返す。
 *
 * 変数は operation ごとに定まるので、複数の operation から使われる fragment の
 * 引数は operation ごとに評価し直す必要がある。その評価と到達の走査の量は
 * operation 数と fragment の大きさの積になり得るので、各 operation が到達する
 * fragment 1 つにつき「1 + その fragment の引数ノード数 + その fragment が
 * spread する相異なる fragment の数」を数え、合計が `maxNodes` を超えたら
 * null (解析できない) を返す。spread 先は fragment ごとに重複を除いてから
 * 数えて辿るので、1 回の訪問の仕事はその訪問の課金を超えない。これで走査と
 * 評価の総量が、operation 自身の大きさ (token 数で抑えられる) と `maxNodes`
 * の和で抑えられる。
 */
function fragmentReachers(
  document: DocumentNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  maxNodes: number,
): ReadonlyMap<string, readonly VariableDefaults[]> | null {
  const adjacency = new Map<string, readonly string[]>();
  const argumentCounts = new Map<string, number>();
  for (const [name, fragment] of fragments) {
    adjacency.set(name, [...new Set(spreadNames(fragment))]);
    argumentCounts.set(name, countArguments(fragment));
  }
  const reachers = new Map<string, VariableDefaults[]>();
  let charged = 0;
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    const defaults = variableDefaults(definition);
    const seen = new Set<string>();
    const stack = [...new Set(spreadNames(definition))];
    while (stack.length > 0) {
      const name = stack.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const edges = adjacency.get(name) ?? [];
      charged += 1 + (argumentCounts.get(name) ?? 0) + edges.length;
      if (charged > maxNodes) return null;
      const list = reachers.get(name);
      if (list === undefined) reachers.set(name, [defaults]);
      else list.push(defaults);
      for (const next of edges) {
        if (!seen.has(next)) stack.push(next);
      }
    }
  }
  return reachers;
}

function countArguments(node: ASTNode): number {
  let count = 0;
  visit(node, {
    Argument() {
      count += 1;
    },
  });
  return count;
}

/**
 * document 中のすべての引数ノード (フィールド引数・directive 引数、深さを
 * 問わず、fragment definition 内も含む) を名前ごとに集める。値が文字列に
 * 解決できた出現は `argumentValues` に、1 つでも解決できなかった出現を持つ
 * 名前は `unresolvedArguments` に載る。両方に載る名前もあり得る。
 *
 * operation 内の引数はその operation の変数の既定値で評価する。fragment 内の
 * 引数は、到達する operation ごとに (document 順に) 評価し、その結果を
 * すべて集める。どの operation からも到達しない fragment の引数は既定値を
 * 持たないものとして `variables` だけで評価する。どの operation が実行
 * されるか (`operationName`) には依存しない。
 */
function collectArguments(
  document: DocumentNode,
  reachers: ReadonlyMap<string, readonly VariableDefaults[]>,
  variables: JsonValue | undefined,
): {
  readonly argumentValues: Readonly<Record<string, readonly string[]>>;
  readonly unresolvedArguments: readonly string[];
} {
  const resolved = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  const unreachable: readonly (VariableDefaults | undefined)[] = [undefined];
  for (const definition of document.definitions) {
    let contexts = unreachable;
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      contexts = [variableDefaults(definition)];
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      contexts = reachers.get(definition.name.value) ?? unreachable;
    }
    visit(definition, {
      Argument(node) {
        const name = node.name.value;
        for (const defaults of contexts) {
          const value = resolveArgumentValue(node.value, variables, defaults);
          if (value === undefined) {
            unresolved.add(name);
            continue;
          }
          const values = resolved.get(name);
          if (values === undefined) resolved.set(name, new Set([value]));
          else values.add(value);
        }
      },
    });
  }
  const argumentValues: Record<string, readonly string[]> = {};
  for (const [name, values] of resolved) argumentValues[name] = [...values];
  return { argumentValues, unresolvedArguments: [...unresolved] };
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
  defaults: VariableDefaults | undefined,
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
  const fallback = defaults?.get(name);
  return fallback?.kind === Kind.STRING ? fallback.value : undefined;
}
