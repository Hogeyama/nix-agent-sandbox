/**
 * 経路条件の文法と、経路に対する facts の参照評価。
 *
 * 設計: docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md
 * 「経路の意味」「経路に紐づく引数条件」に対応する。
 *
 * このモジュールは GraphQL のパーサを import しない。型と通常の collection 操作
 * だけで書いてあるので、production の経路 (resolve / broker / stages) からも
 * 検査器からも同じ規則で使える。document から facts を作るのは `graphql.ts`
 * (参照実装) と addon の仕事であり、ここは「facts が条件を満たすか」だけを決める。
 */

import type { NormalizedGraphql } from "./relation.ts";
import type { Truth } from "./semantics.ts";
import type { GraphqlDocument } from "./types.ts";

/**
 * 許可末端の経路の文法。
 *
 * `/` 始まりの 1 段以上で、各要素は GraphQL の Name。`*` / `**`、空要素、
 * 末尾の `/`、空文字列、JSON Pointer の escape (`~1`) はどれも通らない。
 * 大文字小文字は区別する。
 */
const FIELD_PATH = /^(?:\/[A-Za-z_][0-9A-Za-z_]*)+$/;

export function isGraphqlFieldPath(value: string): boolean {
  return FIELD_PATH.test(value);
}

/**
 * 経路とその祖先を根から並べる。`/a/b/c` → `["/a", "/a/b", "/a/b/c"]`。
 *
 * 証人の構成 (`witness.ts`) と接頭辞集合の計算が同じ分割規則を使うための補助。
 */
export function graphqlPathChain(path: string): readonly string[] {
  const chain: string[] = [];
  for (
    let end = path.indexOf("/", 1);
    end !== -1;
    end = path.indexOf("/", end + 1)
  ) {
    chain.push(path.slice(0, end));
  }
  chain.push(path);
  return chain;
}

/**
 * 許可末端集合の**真の**接頭辞。子を持つ field が通ってよい経路である。
 *
 * 末端そのものは含めない。`/repository/issues/nodes/body` を許しても
 * `/repository` の子を自由に取れるようにはならず、`repository { ... }` は
 * 「この末端へ向かう途中」としてだけ通る。
 */
export function graphqlPathPrefixes(fieldPaths: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const leaf of fieldPaths) {
    for (
      let end = leaf.indexOf("/", 1);
      end !== -1;
      end = leaf.indexOf("/", end + 1)
    ) {
      prefixes.add(leaf.slice(0, end));
    }
  }
  return prefixes;
}

/**
 * document の全出現が経路条件と経路別の引数条件を満たすか。
 *
 * 判定は出現ごとに行う。子を持たない field は許可末端に完全一致し、子を持つ
 * field は許可末端の真の接頭辞でなければならない。名指しした引数は**その出現に
 * 存在し**、解決後の文字列が許可集合に含まれることを要する。
 *
 * 真理値は 3 値である。
 *
 * - 経路違反・引数の欠落・許可外の値は偽。
 * - 名指しした引数がその出現で文字列に解決できなければ判定不能。
 * - facts が無い (`null`) か、末端を 1 つも持たない壊れた facts も判定不能。
 *   偽に倒すと、解析できないボディを送るだけでより広いルールへ落とせる。
 *
 * 判定不能は偽より優先する。経路違反を見つけても引数の走査を打ち切らないのは
 * このためで、「経路だけ合う」facts で未解決の引数を見落とさないようにする。
 * 引数名と field 名は任意の GraphQL Name (`__proto__`、`constructor` を含む)
 * なので、Record の参照は own property 判定で行う。
 */
export function selectionSatisfies(
  condition: Pick<NormalizedGraphql, "fieldPaths" | "fieldArguments">,
  document: GraphqlDocument | null | undefined,
): Truth {
  if (
    document == null ||
    !Array.isArray(document.fields) ||
    !document.fields.some((field) => field.leaf)
  ) {
    return "indeterminate";
  }
  const leaves = new Set(condition.fieldPaths);
  const prefixes = graphqlPathPrefixes(leaves);

  let refused = false;
  let unknown = false;
  for (const field of document.fields) {
    if (!(field.leaf ? leaves : prefixes).has(field.path)) refused = true;
    for (const [name, allowed] of condition.fieldArguments.get(field.path) ??
      []) {
      if (field.unresolvedArguments.includes(name)) {
        unknown = true;
      } else if (
        !Object.hasOwn(field.argumentValues, name) ||
        !allowed.includes(field.argumentValues[name] as string)
      ) {
        refused = true;
      }
    }
  }
  return unknown ? "indeterminate" : refused ? "false" : "true";
}
