# Mask Filter Live Flush Design

## Goal

hostexecで実行した長時間プロセスがstdoutを閉じなくても、`nas-mask-filter`がマスク確定済みの
出力を呼出側へ直ちに渡す。

## Cause

filter modeは`MaskStream`の出力先に64KiBのbuffered stdout writerを渡し、EOF後に一度だけ
flushしている。64KiB未満の出力を行って待機するプロセスではEOFもbuffer満杯も発生しないため、
mask-filterが出力を保持し続ける。

## Design

filter modeの出力先を`stdout.writer(&buffer)`から`stdout.deprecatedWriter()`へ変更する。
`MaskStream`は入力を最大64KiB単位で処理し、マスク判定が確定した範囲だけを`writeAll()`するため、
unbuffered writerでも1バイトごとのsystem callにはならない。

シークレットが入力chunk境界を跨ぐ可能性に備えて末尾`maxSecretLen - 1`バイトを保持する既存動作は
変更しない。変更対象はfilter modeの最終stdout bufferingだけとする。

## Testing

実`nas-mask-filter`を起動し、stdinを閉じずに64KiB未満の文字列を書き込む。有限時間内にstdoutから
マスク済み文字列を読めることを確認する。テスト終了時にstdinを閉じ、processを必ず回収する。

## Scope

- 変更: `src/mask-filter/mask_filter.zig`
- 回帰テスト: `src/stages/maskfs/mask_filter_integration_test.ts`
- 非対象: hostexec protocol、broker streaming、Forgejow lifecycle、serve/supervise mode

## Why — なぜこのアプローチを選んだか

データは既に`MaskStream`内で安全なまとまりに分割されている。最後のstdout bufferだけを外せば、
マスク処理やhostexec protocolを変えずに、データが止まっている境界を直接修正できる。

## Why Not — なぜ他の案を選ばなかったか

- **各chunk後にbufferをflushする** — stream loopの重複または汎用writer APIの変更が必要になる。
- **hostexecでmask-filterを迂回する** — stdoutに含まれるシークレットの保護を失う。
- **Forgejowに64KiB以上出力させる** — 呼出側をbuffer実装へ依存させ、他の長時間コマンドを直せない。
