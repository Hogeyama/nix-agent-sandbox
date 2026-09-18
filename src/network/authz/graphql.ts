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
 * - 未定義の fragment 名を spread する、または spread が循環する
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
 * `variables` メンバ)。オブジェクトでない・キーが無い・値が文字列でない
 * 場合、その変数は解決不能として `unresolvedArguments` に載る。
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
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  // operation を持たない document はサーバで実行できない。検査ゲートが黙って
  // 通す理由がないので「解析できない」とする。
  if (operations.length === 0) return null;
  if (!spreadsAreValid(document, fragments)) return null;

  return {
    operations: [...new Set(operations)],
    rootFields: [...collectRootFields(document, fragments)],
    ...collectArguments(document, variables),
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

/**
 * document 中のすべての引数ノード (フィールド引数・directive 引数、深さを
 * 問わず、fragment definition 内も含む) を名前ごとに集める。値が文字列に
 * 解決できた出現は `argumentValues` に、1 つでも解決できなかった出現を持つ
 * 名前は `unresolvedArguments` に載る。両方に載る名前もあり得る。
 */
function collectArguments(
  document: DocumentNode,
  variables: JsonValue | undefined,
): {
  readonly argumentValues: Readonly<Record<string, readonly string[]>>;
  readonly unresolvedArguments: readonly string[];
} {
  const resolved = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  visit(document, {
    Argument(node) {
      const name = node.name.value;
      const value = resolveArgumentValue(node.value, variables);
      if (value === undefined) {
        unresolved.add(name);
        return;
      }
      const values = resolved.get(name);
      if (values === undefined) resolved.set(name, new Set([value]));
      else values.add(value);
    },
  });
  const argumentValues: Record<string, readonly string[]> = {};
  for (const [name, values] of resolved) argumentValues[name] = [...values];
  return { argumentValues, unresolvedArguments: [...unresolved] };
}

/**
 * 引数の値を文字列に解決する。文字列リテラルはそのまま、`$v` は
 * `variables` の `v` が文字列のときだけその値になる。その他のリテラル
 * (Int / Float / Boolean / Null / Enum / List / Object) と解決できない
 * 変数は解決不能 (undefined) である。
 */
function resolveArgumentValue(
  value: ValueNode,
  variables: JsonValue | undefined,
): string | undefined {
  if (value.kind === Kind.STRING) return value.value;
  if (value.kind !== Kind.VARIABLE) return undefined;
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables)
  ) {
    return undefined;
  }
  const record = variables as { readonly [key: string]: JsonValue };
  if (!Object.hasOwn(record, value.name.value)) return undefined;
  const resolved = record[value.name.value];
  return typeof resolved === "string" ? resolved : undefined;
}
