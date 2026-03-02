/**
 * Stage インターフェースとパイプライン実行
 */

import type { ExecutionContext } from "./context.ts";

/** 各ステージが実装するインターフェース */
export interface Stage {
  name: string;
  execute(ctx: ExecutionContext): Promise<ExecutionContext>;
}

/** ステージを順次実行するパイプライン */
export async function runPipeline(
  stages: Stage[],
  ctx: ExecutionContext,
): Promise<ExecutionContext> {
  let current = ctx;
  for (const stage of stages) {
    console.log(`[naw] Running stage: ${stage.name}`);
    current = await stage.execute(current);
  }
  return current;
}
