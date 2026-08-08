/**
 * 特異度の半順序と、評価順の決定。
 *
 * 設計「選択規則 > 特異度の順序」「評価順」に対応する。特異度は受理集合の包含
 * から導かれる。A の受理集合が B の真部分集合であるとき A が B より特異である。
 */

import {
  type CompiledMatch,
  matchSubsumes,
  targetSetsSubsume,
} from "./relation.ts";
import type { Target } from "./types.ts";

export type Specificity =
  /** 受理集合が互いを包含する。特異度で優劣が付かない。 */
  | "equivalent"
  /** a が b より特異 (a ⊂ b)。 */
  | "narrower"
  /** a が b より広い (b ⊂ a)。 */
  | "wider"
  /** どちらも他方を包含しない。 */
  | "incomparable";

export function compareSpecificity(
  a: CompiledMatch,
  b: CompiledMatch,
): Specificity {
  return orderOf(matchSubsumes(a, b), matchSubsumes(b, a));
}

export function compareTargetSpecificity(
  a: readonly Target[],
  b: readonly Target[],
): Specificity {
  return orderOf(targetSetsSubsume(a, b), targetSetsSubsume(b, a));
}

function orderOf(aInB: boolean, bInA: boolean): Specificity {
  if (aInB && bInA) return "equivalent";
  if (aInB) return "narrower";
  if (bInA) return "wider";
  return "incomparable";
}

/**
 * 候補を評価する順に並べる。
 *
 * 特異度の降順に評価し、特異度で決着しない組は宣言順で評価する。特異度は全順序
 * ではないので単なる比較関数では並べられない。「より特異な側が先」という半順序を
 * 辺とする DAG の、宣言順を優先した位相ソートとして実装する。
 *
 * 宣言順を持ち出す理由は設計「評価順」にある。判定不能に到達した時点で評価を
 * 打ち切るので、交差しない比較不能な組でも相対順序が観測できてしまう。
 *
 * `overrides` による明示的な優先は扱わない。包含から導かれる順序だけを対象にする。
 * 明示の優先も混ぜたい呼び手は `precedenceOrder` を直接使う。
 */
export function evaluationOrder<T>(
  items: readonly T[],
  matchOf: (item: T) => CompiledMatch,
): PrecedenceOutcome<T> {
  const matches = items.map(matchOf);
  return precedenceOrder(
    items,
    // i が j より特異なら、i を先に評価する。
    (_a, _b, i, j) =>
      compareSpecificity(
        matches[i] as CompiledMatch,
        matches[j] as CompiledMatch,
      ) === "narrower",
  );
}

/**
 * 並べ替えの結果。閉路があれば順序を作らず、閉路そのものを返す。
 *
 * 「並べられなかった」を「とりあえず宣言順」に潰さないための型である。優先関係の
 * 閉路は解決可能な順序を持たないのだから、順序があるかのように振る舞ってはならない。
 */
export type PrecedenceOutcome<T> =
  | { readonly ok: true; readonly ordered: readonly T[] }
  /** 閉路を構成する要素。`cycle[k]` は `cycle[k+1]` より先で、末尾は先頭より先。 */
  | { readonly ok: false; readonly cycle: readonly T[] };

/**
 * 「a を b より先に評価する」という半順序に従って並べる。
 *
 * 半順序なので単なる比較関数では並べられない。優先関係を辺とする DAG の、
 * 宣言順を優先した位相ソートとして実装する。優先関係で決着しない組は宣言順で
 * 並ぶ。
 *
 * `precedes` に閉路があると位相ソートが詰まる。そのときは失敗を返す。残りを宣言順で
 * 吐いて進むと、閉路に加わっていない要素まで宣言順に落ち、優先関係が丸ごと無効に
 * なる。順序で安全側を決めている呼び手にとってそれは静かな緩みなので、順序を
 * でっち上げずに呼び手へ返して止めさせる。
 */
export function precedenceOrder<T>(
  items: readonly T[],
  precedes: (a: T, b: T, indexA: number, indexB: number) => boolean,
): PrecedenceOutcome<T> {
  const size = items.length;
  const predecessors = items.map(() => new Set<number>());
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (i === j) continue;
      if (precedes(items[i] as T, items[j] as T, i, j)) {
        (predecessors[j] as Set<number>).add(i);
      }
    }
  }

  const ordered: T[] = [];
  const emitted = new Set<number>();
  while (ordered.length < size) {
    let next = -1;
    for (let index = 0; index < size; index++) {
      if (emitted.has(index)) continue;
      const waiting = predecessors[index] as Set<number>;
      if ([...waiting].every((from) => emitted.has(from))) {
        next = index;
        break;
      }
    }
    if (next === -1) {
      return {
        ok: false,
        cycle: findCycle(size, predecessors, emitted).map(
          (index) => items[index] as T,
        ),
      };
    }
    emitted.add(next);
    ordered.push(items[next] as T);
  }
  return { ok: true, ordered };
}

/**
 * 位相ソートが詰まった時点で、残っている節点から閉路を 1 つ取り出す。
 *
 * 残っている節点は必ず残っている先行者を持つ。持たなければ吐けたはずだからである。
 * 先行者を辿り続ければ有限回で既訪の節点に戻り、そこから先が閉路になる。
 */
function findCycle(
  size: number,
  predecessors: readonly Set<number>[],
  emitted: ReadonlySet<number>,
): readonly number[] {
  let at = -1;
  for (let index = 0; index < size; index++) {
    if (!emitted.has(index)) {
      at = index;
      break;
    }
  }
  if (at === -1) return [];

  // 先行者を辿るので、walk は「後に評価する側 → 先に評価する側」の向きに伸びる。
  const walk: number[] = [];
  const visitedAt = new Map<number, number>();
  while (!visitedAt.has(at)) {
    visitedAt.set(at, walk.length);
    walk.push(at);
    const from = [...(predecessors[at] as Set<number>)].find(
      (index) => !emitted.has(index),
    );
    if (from === undefined) return [at];
    at = from;
  }
  return walk.slice(visitedAt.get(at) as number).reverse();
}
