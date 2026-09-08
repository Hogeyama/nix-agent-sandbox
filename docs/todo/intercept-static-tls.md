# TODO: preload interceptor の static TLS 256KiB を削る

優先度: **P1**（コンテナ内の全プロセスに影響する。小さいスタックでスレッドを作る
プログラムが軒並み起動できなくなり、JVM 系のツールチェーンはほぼ全滅する）

状態: 未着手。`59b9898e build: support Zig 0.16 for native helpers` で混入した。

---

## 症状

コンテナ内で Gradle が daemon を起動できない。

```
$ ./gradlew test
[0.727s][warning][os,thread] Failed to start thread "Unknown thread" - pthread_create failed (EINVAL) for attributes: stacksize: 136k, guardsize: 4k, detached.
[0.728s][warning][os,thread] Failed to start the native thread for java.lang.Thread "process reaper"

FAILURE: Build failed with an exception.
* What went wrong:
A problem occurred starting process 'Gradle build daemon'
```

JVM は `process reaper` スレッドを 136KiB のスタックで作る。これが EINVAL で失敗すると
Gradle launcher は daemon プロセスを reap できず、ビルド全体が落ちる。Java 固有ではなく、
`PTHREAD_STACK_MIN` 近辺の小さいスタックでスレッドを作るプログラムはすべて影響を受ける。

## 原因

`/opt/nas/hostexec/lib/hostexec_intercept.so` の PT_TLS が 256KiB ある。

```
$ readelf -lW /opt/nas/hostexec/lib/hostexec_intercept.so | grep '^  TLS'
  TLS  0x097070 0x0000000000098070 0x0000000000098070 0x000000 0x040015 R 0x8

$ readelf -sW /opt/nas/hostexec/lib/hostexec_intercept.so | grep signal_stack
  685: 0000000000000015 0x40000 TLS LOCAL DEFAULT 14 Thread.maybeAttachSignalStack.global.signal_stack
```

glibc の `allocate_stack()` は `guardsize + __static_tls_size + MINIMAL_REST_STACK` 未満の
スタック要求を EINVAL で弾く。LD_PRELOAD したライブラリの static TLS はコンテナ内の
全プロセスの `__static_tls_size` に加算されるので、この 256KiB が全プロセスの
最小スレッドスタックを 256KiB 超へ押し上げる。

Zig 0.16 の std が `Thread.maybeAttachSignalStack` の `threadlocal` シグナルスタックを
成果物へ無条件に載せるようになったことが直接の原因で、0.15.2 では載っていなかった。

## 再現手順

### 影響の確認（コンテナ内で実行する）

```c
/* tls.c */
#include <stdio.h>
#include <pthread.h>
static void *fn(void *a) { return NULL; }
int main(void) {
  for (size_t s = 16384; s <= 1u << 20; s *= 2) {
    pthread_attr_t at; pthread_attr_init(&at);
    pthread_attr_setstacksize(&at, s);
    pthread_attr_setguardsize(&at, 4096);
    pthread_t t;
    printf("stacksize=%zu -> %d\n", s, pthread_create(&t, &at, fn, NULL));
  }
  return 0;
}
```

```
$ cc -o tls tls.c && ./tls
stacksize=16384  -> 22   (EINVAL)
stacksize=131072 -> 22   (EINVAL)   ← JVM の process reaper がここ
stacksize=262144 -> 22   (EINVAL)
stacksize=524288 -> 0

$ env -u LD_PRELOAD ./tls
stacksize=16384  -> 0    (以降すべて 0)
```

### コンパイラ側の切り分け

std を一切 import しない最小のソースでも再現する。

```zig
// nostd.zig
export fn hook(n: c_int) c_int { return n; }
```

```
$ zig-0.15.2 build-lib -dynamic -lc -fPIC nostd.zig && readelf -lW libnostd.so | grep '^  TLS'
  TLS ... 0x000010
$ zig-0.16.0 build-lib -dynamic -lc -fPIC nostd.zig && readelf -lW libnostd.so | grep '^  TLS'
  TLS ... 0x040028
```

optimize モード別の PT_TLS memsz（zig 0.16.0）:

| optimize | TLS memsz |
| --- | --- |
| Debug | 0x040028 |
| ReleaseSafe | 0x040015 |
| ReleaseFast | セグメント自体が無い |
| ReleaseSmall | セグメント自体が無い |
| ReleaseSafe + `-fsingle-threaded` | セグメント自体が無い |

`flake.nix` の hostexec-intercept は `-Doptimize=ReleaseSafe` でビルドしており、
表の 0x040015 が出荷された .so の値と一致する。

### 過去ビルドとの比較

nix store に残る旧ビルドと現行ビルドを並べると差分が見える。

```
$ for f in /nix/store/*hostexec-intercept*/lib/hostexec_intercept.so; do
    echo "$f"; readelf -lW "$f" | grep '^  TLS'
  done
dd9crrd9... 0x00001d   (旧)
f5dx7hwh... 0x00001d   (旧)
wbmy9hyd... 0x040015   (現行)
```

## 対処の候補

1. `.so` のみ `-fsingle-threaded` でビルドする。ReleaseSafe を保ったまま TLS が消える。
   ただし `protocol.zig` の `debug_flag_cache` が `std.atomic.Value` なので、
   single-threaded 前提で壊れないかを確認する必要がある。interceptor は preload 先の
   任意のスレッドから呼ばれるため、ここは慎重に判断する。
2. `.so` のみ `ReleaseFast` / `ReleaseSmall` でビルドする。確実に消えるが安全性チェックを失う。
   client / gateway は別プロセスなので ReleaseSafe のままでよい。
3. panic ハンドラの差し替え（`pub const panic = std.debug.simple_panic;`）では消えない。
   ReleaseSafe で 0x04000d が残るので、この方向は効かない。

`build.zig` で `lib_mod` だけ設定を変えれば足りる。client / gateway は LD_PRELOAD されないので、
static TLS の大きさは問題にならない。

## 当座の回避策

利用者側で JVM の reaper スレッドに既定スタックサイズを使わせると回避できる。

```bash
JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS -Djdk.lang.processReaperUseDefaultStackSize=true" ./gradlew test
```

これは JVM に限った話で、ほかの言語ランタイムには別の回避策が要る。
