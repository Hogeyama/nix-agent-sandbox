/**
 * Stage インターフェースとパイプライン実行
 */

import type { ExecutionContext } from "./context.ts";
import { logInfo } from "../log.ts";

/** 各ステージが実装するインターフェース */
export interface Stage {
  name: string;
  execute(ctx: ExecutionContext): Promise<ExecutionContext>;
  teardown?(ctx: ExecutionContext): Promise<void>;
}

/** ステージを順次実行するパイプライン。完了済みステージの teardown を逆順で呼ぶ。 */
export async function runPipeline(
  stages: Stage[],
  ctx: ExecutionContext,
): Promise<ExecutionContext> {
  const completed: Stage[] = [];
  let current = ctx;
  try {
    for (const stage of stages) {
      logInfo(`[nas] Running stage: ${stage.name}`);
      current = await stage.execute(current);
      completed.push(stage);
    }
    return current;
  } finally {
    for (const stage of completed.reverse()) {
      if (stage.teardown) {
        try {
          logInfo(`[nas] Teardown: ${stage.name}`);
          await stage.teardown(current);
        } catch (err) {
          console.error(
            `[nas] Teardown error in ${stage.name}: ${(err as Error).message}`,
          );
        }
      }
    }
  }
}
