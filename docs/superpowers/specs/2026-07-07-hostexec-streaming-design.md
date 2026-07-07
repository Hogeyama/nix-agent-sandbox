# hostexec stdout/stderr ストリーミング

## 目的

`broker.ts:runResolved` がコマンドの stdout/stderr を全量バッファリングしてからプロセス終了後に一括返却している。`./gradlew jar` のような長時間コマンドはコンテナ側に一切出力が見えない。ReadableStream のチャンク単位で逐次送出する。

## 方式

既存の JSON 行プロトコルに `chunk` メッセージ型を追加する NDJSON ストリーム方式。

```
現在: request\n → (沈黙) → result\n
変更: request\n → chunk\n → chunk\n → ... → result\n
```

fallback / error は従来通りチャンクなしで即座に返る。出力なしの高速コマンドではチャンクが0個で result だけ返る。

## プロトコル変更 (`src/hostexec/types.ts`)

### 追加: `ExecuteChunkResponse`

```typescript
interface ExecuteChunkResponse {
  type: "chunk";
  requestId: string;
  fd: 1 | 2;     // 1=stdout, 2=stderr
  data: string;   // base64-encoded bytes
}
```

### 変更: `ExecuteResultResponse`

stdout / stderr フィールドを削除する。

```typescript
interface ExecuteResultResponse {
  type: "result";
  requestId: string;
  exitCode: number;
}
```

### 変更: `HostExecBrokerResponse`

ユニオンに `ExecuteChunkResponse` を追加する。

## broker 変更 (`src/hostexec/broker.ts`)

### `runResolved` のシグネチャ変更

ソケットを引数に受け取り、戻り値を `void` に変更する。チャンクとリザルトを内部でソケットに直接書き出す。

### 新しいフロー

1. `Bun.spawn` で子プロセスを起動（`stdout: "pipe"`, `stderr: "pipe"`）
2. stdin があれば書き込む
3. stdout と stderr の ReadableStream を並行で読み、チャンクごとに `writeJsonLine` でソケットに `chunk` メッセージを書き出す
4. 両ストリーム完了 + `proc.exited` を待つ
5. `result` メッセージ（exitCode のみ）をソケットに書き出す

```typescript
async function pipeStreamToSocket(
  stream: ReadableStream<Uint8Array>,
  socket: Socket,
  requestId: string,
  fd: 1 | 2,
): Promise<void> {
  for await (const chunk of stream) {
    await writeJsonLine(socket, {
      type: "chunk",
      requestId,
      fd,
      data: Buffer.from(chunk).toString("base64"),
    });
  }
}
```

stdout と stderr の writeJsonLine が並行で走るが、各 writeJsonLine は1つの JSON 行を atomic に書くので行が混ざることはない。

### `handleConnection` の変更

execute → runResolved のパスではソケット書き込みが runResolved 内で完了するため、handleConnection は writeJsonLine を呼ばない。fallback / error / その他のメッセージタイプは従来通り。

### `redactSecretsBytes` の削除

関数定義、runResolved 内の呼び出し、secretValues 収集ロジックを削除する。シークレット墨消しは hostexec broker ではほぼ使われておらず、ストリーミング化で不要になる。MaskFS / ネットワークプロキシの墨消し（`src/lib/mask_secrets.ts`）は別系統で影響なし。

## Zig インターセプタ変更 (`src/hostexec/intercept/hostexec_intercept.zig`)

### `callBrokerInner` の変更

レスポンス読み取りを NDJSON ループに変更する。

現在: 改行1つで終了 → parseResponse → stdout/stderr 一括 write

変更後:
1. ソケットからバッファ付きで読む
2. 改行で区切って1行ずつ処理。残りはバッファに保持
3. `type:"chunk"` → `data` を base64 デコードして `fd` (1 or 2) に write
4. `type:"result"` → exitCode を取得してループ終了
5. `type:"fallback"` / `type:"error"` → 従来通り即時処理（チャンクの前に来る）

### `BrokerResponse` / `parseResponse` の変更

- `BrokerResponse.ResponseType` に `.chunk` を追加
- `stdout_b64` / `stderr_b64` フィールドを削除
- `data_b64: []const u8` と `fd: i32` フィールドを追加（chunk 型でのみ使用）

## Python ラッパー変更 (`src/stages/hostexec/stage.ts` 内 `buildWrapperScript`)

### `call_broker` → `stream_broker`

ソケットからバッファ付きで行を読むループに変更。

```python
def stream_broker(payload: dict) -> int:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(os.environ["NAS_HOSTEXEC_SOCKET"])
    try:
        sock.sendall((json.dumps(payload) + "\n").encode())
        buf = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                msg = json.loads(line)
                if msg["type"] == "chunk":
                    data = base64.b64decode(msg["data"])
                    if msg["fd"] == 1:
                        sys.stdout.buffer.write(data)
                        sys.stdout.flush()
                    else:
                        sys.stderr.buffer.write(data)
                        sys.stderr.flush()
                elif msg["type"] == "result":
                    return int(msg.get("exitCode", 0))
                elif msg["type"] == "fallback":
                    return None  # signal fallback
                elif msg["type"] == "error":
                    print(msg.get("message", "unknown error"), file=sys.stderr)
                    return 1
        return 1
    finally:
        sock.close()
```

`main()` は `stream_broker` を呼び出し、戻り値が `None` なら fallback 処理、int ならその exit code で終了。stdout/stderr の一括書き出しコードは削除。

## テスト戦略

### broker unit test (`src/hostexec/broker_test.ts`)

- runResolved のストリーミング動作を検証: fake ソケットペアに対して実行し、受信した NDJSON 行列を検証
- チャンクの fd 値（1/2）が正しいこと
- result メッセージに exitCode だけ含まれ stdout/stderr がないこと
- 出力なしコマンドで chunk が0個、result だけ来ること

### zig unit test (hostexec_intercept.zig inline tests)

- parseResponse の chunk 型パース
- fd フィールドの取得
- data_b64 のデコード

### intercept integration test (`src/hostexec/intercept_integration_test.ts`)

- mock broker がチャンクを逐次送信し、zig インターセプタが fd 1/2 に正しく書き分けること

### broker integration test (`src/hostexec/broker_integration_test.ts`)

- 既存テストの更新: result レスポンスのスキーマが変わるので assertion を修正
- ストリーミング end-to-end テスト追加: 実コマンド実行でチャンクが到着すること

## スコープ外

- tty 対応: 現行の `tty: false` 固定は変更しない
- audit ログへの stdout/stderr 記録: 現在も記録していないので変更なし
- MaskFS / ネットワークプロキシの墨消し: 別系統で影響なし

## コーディング規約

- **effect-separation**: broker.ts の変更は HostExecBrokerService 配下。runResolved はクラスの private メソッドであり、ステージからは service 経由で呼ばれる。ステージコード自体の変更はない
- **test-policy**: 新規テストはソース隣接で co-location。Docker 不要のものは `*_test.ts`、Docker 必要なものは `*_integration_test.ts`
