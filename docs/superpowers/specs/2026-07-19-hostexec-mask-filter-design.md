# hostexec mask.filter 対応

## 概要

hostexec ブローカーがホスト側で実行したコマンドの stdout/stderr を、既存の `mask.filter` 設定に基づいて `nas-mask-filter` Zig バイナリでマスクする。

## 背景

- `mask.filter` はコンテナ内コマンドの stdout/stderr からシークレットをマスクする機能
- hostexec 経由のコマンドはホスト側で実行され、出力はソケット経由でコンテナに返却される
- 現状、hostexec 経由の出力にはマスクが適用されない

## 設計

### データフロー

```
host command stdout → nas-mask-filter stdin → nas-mask-filter stdout → pipeStreamToSocket → container
host command stderr → nas-mask-filter stdin → nas-mask-filter stdout → pipeStreamToSocket → container
```

コマンド実行ごとに stdout 用・stderr 用の 2 プロセスを spawn する。

### 有効化条件

既存の mask 設定をそのまま使用する:

- `mask.filter === true` AND `mask.values.length > 0`

hostexec 固有のオプションは追加しない。

### 変更箇所

#### 1. `HostExecBrokerOptions` (broker.ts)

```typescript
interface HostExecBrokerOptions {
  // ... 既存フィールド
  maskFilter?: { binaryPath: string; secretsFramePath: string };
}
```

#### 2. hostexec stage (stage.ts)

`planHostExec` (または stage の Effect) で mask.filter を解決する:

1. `profile.mask.filter === true` かつ `profile.mask.values.length > 0` を確認
2. `resolveMaskSecrets(profile.mask.values)` でシークレット文字列を解決
3. `encodeMaskSecrets(secrets)` でフレームバイナリを生成
4. フレームファイルを hostexec の session tmp dir に書き出す
5. `resolveAssetBinary("nas-mask-filter")` (または mask_filter_path の既存ヘルパー) でバイナリパスを解決
6. `{ binaryPath, secretsFramePath }` をブローカーオプションに渡す

#### 3. `HostExecBroker.runResolved` (broker.ts)

maskFilter が設定されている場合の処理:

```typescript
private async runResolved(request, resolved, socket): Promise<void> {
  const proc = Bun.spawn([commandArgv0, ...request.args], { ... });

  const wrapStream = (stream: ReadableStream<Uint8Array>) => {
    if (!this.maskFilter) return stream;
    const filter = Bun.spawn([this.maskFilter.binaryPath], {
      stdin: stream,
      stdout: "pipe",
      stderr: "ignore",
      env: { NAS_MASK_SECRETS_FILE: this.maskFilter.secretsFramePath },
    });
    return filter.stdout as ReadableStream<Uint8Array>;
  };

  await Promise.all([
    pipeStreamToSocket(wrapStream(proc.stdout), socket, requestId, 1),
    pipeStreamToSocket(wrapStream(proc.stderr), socket, requestId, 2),
  ]);
  // ...
}
```

#### 4. フレームファイルの配置

`<sessionBrokerDir>/mask-secrets.frame` に配置。このディレクトリはコンテナにマウントされないため、エージェントからシークレットフレームにアクセスできない。ブローカー起動時に 1 回だけ書き出す（セッション中シークレットは不変）。

### 既存ヘルパーの再利用

| ヘルパー | 場所 | 用途 |
|---------|------|------|
| `resolveMaskSecrets` | `src/lib/mask_secrets.ts` | MaskValueConfig[] → string[] |
| `encodeMaskSecrets` | `src/stages/maskfs/secrets_frame.ts` | string[] → Uint8Array (frame) |
| `resolveMaskFilterBinaryPath` | `src/stages/maskfs/mask_filter_path.ts` | ホスト上の Zig バイナリパス |

### テスト方針

- **Unit test**: `runResolved` に maskFilter を渡した場合に出力がマスクされることを確認。fake の nas-mask-filter（stdin をそのまま `***` に置換するスクリプト）を PATH に配置。
- **Unit test**: maskFilter が未設定の場合に従来通り生出力が返ることを確認。

### スコープ外

- hostexec 独自のフィルタ設定追加
- stdin（コンテナ→ホスト方向）のマスク
- フレームファイルのセッション中動的更新
