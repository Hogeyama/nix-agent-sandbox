/**
 * このプロセスが使う session id を決める。
 *
 * 環境変数の `NAS_SESSION_ID` を採用するのは `NAS_INSIDE_DTACH=1` と組で
 * 渡されたときだけ。dtach 再実行と UI からの起動はこの 2 つを必ず一緒に設定
 * する。nas コンテナ内ではエージェントの環境に `NAS_SESSION_ID` が入って
 * いるため、無条件に採用すると、その中で起動した nas が親の id を使い回し、
 * dtach ソケットや Docker リソース名が親セッションと衝突する。
 */
export function resolveSessionId(
  env: NodeJS.ProcessEnv,
  generate: () => string,
): string {
  if (env.NAS_INSIDE_DTACH === "1" && env.NAS_SESSION_ID) {
    return env.NAS_SESSION_ID;
  }
  return generate();
}
