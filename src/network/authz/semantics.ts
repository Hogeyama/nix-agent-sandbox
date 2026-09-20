/**
 * `match` の受理条件そのものの参照実装。
 *
 * relation.ts が「受理集合どうしの関係」を判定するのに対し、こちらは「1 本の
 * リクエストを受理するか」を決める。設計「判定不能」に従って真・偽・判定不能の
 * 3 値を返す。判定不能を偽と混ぜない。混ぜると壊れたボディを送れば条件を回避
 * できるという抜け道が生まれる。
 *
 * relation.ts の健全性はこの意味論に対して定義される。「A ⊆ B と判定したなら、
 * A が真を返すリクエストでは B も真を返す」がプロパティテストの内容である。
 */

import { selectionSatisfies } from "./graphql_selection.ts";
import { compiledPathMatches } from "./pattern.ts";
import type {
  CompiledMatch,
  NormalizedBody,
  NormalizedGraphql,
} from "./relation.ts";
import { scalarKey } from "./relation.ts";
import type {
  AuthzRequest,
  GraphqlDocument,
  JsonScalar,
  JsonValue,
  RequestBody,
} from "./types.ts";

export type Truth = "true" | "false" | "indeterminate";

export function evaluateMatch(
  match: CompiledMatch,
  request: AuthzRequest,
): Truth {
  if (match.methods !== null && !match.methods.includes(request.method)) {
    return "false";
  }
  if (!match.paths.some((path) => compiledPathMatches(path, request.path))) {
    return "false";
  }
  return evaluateBody(match.body, request.body, request.path);
}

export function accepts(match: CompiledMatch, request: AuthzRequest): boolean {
  return evaluateMatch(match, request) === "true";
}

/**
 * `requestPath` はクエリ文字列を含むリクエストのパスである。読むのは `graphql`
 * 条件だけで、クエリ文字列の有無しか見ない (`hasQueryString`)。
 */
export function evaluateBody(
  condition: NormalizedBody,
  body: RequestBody,
  requestPath: string,
): Truth {
  if (condition.format === null) return "true";
  // ボディが存在しないリクエストは、ボディの存在を要求するどの format も満たさ
  // ない。「ボディ条件を持たない match は "opaque" より広い」の根拠がこれである。
  if (body.kind === "absent") return "false";

  switch (condition.format) {
    case "none":
      // 「ボディが存在し、その長さが 0 である」
      return body.kind === "empty"
        ? evaluateContent(condition, body, requestPath)
        : "false";
    case "opaque":
      // ボディの存在だけを条件にし、内容を解析しない。
      return evaluateContent(condition, body, requestPath);
    case "json":
      if (body.kind === "json") {
        return evaluateContent(condition, body, requestPath);
      }
      // 0 バイトのボディも壊れたボディも JSON として解析できない。偽ではなく
      // 判定不能である。
      return "indeterminate";
  }
}

function evaluateContent(
  condition: NormalizedBody,
  body: RequestBody,
  requestPath: string,
): Truth {
  if (condition.pointers.size === 0 && condition.graphql === null)
    return "true";
  if (body.kind !== "json") {
    // format が "none" / "opaque" なのに値条件を持つ設定は設定エラーだが、
    // ここでは真を返さず判定不能に倒す。
    return "indeterminate";
  }

  let indeterminate = false;
  let determinedFalse = false;
  for (const [pointer, values] of condition.pointers) {
    switch (evaluatePointer(body.value, pointer, values)) {
      case "indeterminate":
        indeterminate = true;
        break;
      case "false":
        determinedFalse = true;
        break;
      case "true":
        break;
    }
  }

  if (condition.graphql !== null) {
    switch (evaluateGraphql(condition.graphql, body, requestPath)) {
      case "indeterminate":
        indeterminate = true;
        break;
      case "false":
        determinedFalse = true;
        break;
      case "true":
        break;
    }
  }

  // 判定不能を偽より優先する。真になれない候補で評価を打ち切らせるためである。
  if (indeterminate) return "indeterminate";
  return determinedFalse ? "false" : "true";
}

function evaluatePointer(
  root: JsonValue,
  pointer: string,
  values: readonly JsonScalar[],
): Truth {
  const found = resolvePointer(root, pointer);
  // 対象が存在しない場合は偽であり、判定不能ではない。
  if (found === undefined) return "false";
  if (!isScalar(found)) return "indeterminate";
  const keys = new Set(values.map(scalarKey));
  return keys.has(scalarKey(found)) ? "true" : "false";
}

/**
 * URL にクエリ文字列があれば、ボディを見る前に判定不能とする。ボディに
 * document が無くても同じである。GraphQL のサーバは document と変数を URL
 * からも読む。express-graphql は `?query=` / `?variables=` をボディより優先し、
 * Rails はクエリ文字列の引数をボディの引数とまとめる (`variables[login]=x` は
 * 入れ子のハッシュになる)。実行されるものがボディの document と同じだと言え
 * ないので、真も偽も言えない。偽にすると、`?query=mutation...` と無関係な
 * ボディを送るだけでより広いルールへ落とせる。引数名の一覧ではなくクエリ
 * 文字列の有無で決めるのは、名前も綴りもサーバごとに違うからである。
 */
function evaluateGraphql(
  condition: NormalizedGraphql,
  body: Extract<RequestBody, { kind: "json" }>,
  requestPath: string,
): Truth {
  if (hasQueryString(requestPath)) return "indeterminate";
  const document = body.documents?.[condition.at];
  if (document === undefined) {
    const found = resolvePointer(body.value, condition.at);
    // 対象が存在しないなら偽。存在するのに document として読めないなら判定不能。
    return found === undefined ? "false" : "indeterminate";
  }
  return satisfiesDocument(condition, document);
}

/**
 * `operations` と経路条件の AND。
 *
 * 経路と経路別の引数は `selectionSatisfies` が出現ごとに決める。ここが足すのは
 * operation の集合の検査と、判定不能を偽より優先する合成だけである。経路が偽に
 * なっても引数の走査を打ち切らないのは `selectionSatisfies` の中の話だが、
 * 同じ理由でここも operation が偽だからといって経路の評価を飛ばさない。飛ばすと
 * 「未解決の引数を持つ document」が偽になり、壊れた変数を送るだけでより広い
 * ルールへ落とせる fail-open になる。
 *
 * `operations` が空の facts は有効な document から作れない (実行可能な document は
 * 最低 1 つの operation を持つ)。手書き・旧形式の facts を空集合として黙って
 * 通さないために、判定不能に倒す。
 */
function satisfiesDocument(
  condition: NormalizedGraphql,
  document: GraphqlDocument,
): Truth {
  const selection = selectionSatisfies(condition, document);
  if (selection === "indeterminate") return "indeterminate";
  if (!Array.isArray(document.operations) || document.operations.length === 0) {
    return "indeterminate";
  }
  if (!document.operations.every((op) => condition.operations.includes(op))) {
    return "false";
  }
  return selection;
}

/** リクエストのパスが空でないクエリ文字列 (`?` の後に 1 文字以上) を持つか。 */
export function hasQueryString(requestPath: string): boolean {
  const query = requestPath.indexOf("?");
  return query !== -1 && query + 1 < requestPath.length;
}

export function resolvePointer(
  root: JsonValue,
  pointer: string,
): JsonValue | undefined {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: JsonValue = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const next = current[Number.parseInt(token, 10)];
      if (next === undefined) return undefined;
      current = next;
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    const record = current as { readonly [key: string]: JsonValue };
    if (!Object.hasOwn(record, token)) return undefined;
    current = record[token] as JsonValue;
  }
  return current;
}

function isScalar(value: JsonValue): value is JsonScalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
