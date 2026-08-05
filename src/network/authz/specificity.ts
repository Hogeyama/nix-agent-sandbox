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
 * `overrides` による明示的な優先は扱わない。段階 0 は包含から導かれる順序だけを
 * 対象にする。
 */
export function evaluationOrder<T>(
  items: readonly T[],
  matchOf: (item: T) => CompiledMatch,
): readonly T[] {
  const matches = items.map(matchOf);
  const size = items.length;
  const predecessors = items.map(() => new Set<number>());
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (i === j) continue;
      // i が j より特異なら、i を先に評価する。
      if (
        compareSpecificity(
          matches[i] as CompiledMatch,
          matches[j] as CompiledMatch,
        ) === "narrower"
      ) {
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
    // 包含は推移的なので閉路は生じないが、判定の不完全さで詰まっても停止させる。
    if (next === -1) {
      for (let index = 0; index < size; index++) {
        if (!emitted.has(index)) {
          emitted.add(index);
          ordered.push(items[index] as T);
        }
      }
      break;
    }
    emitted.add(next);
    ordered.push(items[next] as T);
  }
  return ordered;
}
