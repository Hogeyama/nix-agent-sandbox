---
Status: Accepted
Date: 2026-04-18
---

# ADR: xpra runtime GC — self-invoked at startXpra

## Context
`display.sandbox: "xpra"` 起動時、nas は host 上に xpra server / attach
client、`/tmp/.X11-unix/XN` socket、および
`$XDG_RUNTIME_DIR/nas/display/<sessionId>/` (Xauthority, xpra.log, ...) を
作る。正常系では Effect scope 終了時の finalizer が process を kill し、
xpra 自身が socket を unlink するため残骸は出ない。しかし SIGKILL / OOM /
電源断のように finalizer が走れない経路では、これらが次回以降も残り
display number を占有する。

GC は必要だが、どの lifecycle site に置くかで設計が大きく変わる — CLI
pre-run, UI daemon 起動時, `stopContainer` / `cleanContainers` の複数に
分散すれば網羅性は上がるが、維持する境界が増える。

## Decision
GC は `DisplayService.startXpra` 自身が起動時に一度実行する、を唯一の
trigger にする。xpra を起こすパスが必ず先に GC を通るので、これだけで
UI 経由でも CLI 単発でも孤児は回収される。

Registry は display 専用の純 async fs モジュール (`src/display/registry.ts`)
として置き、Effect Service 化しない。consumer が `startXpra` の一箇所
だけなので、Service tag を挟むと固有の value を増やさず noise を増やす
だけ。Registry は XDG 配下の `display/` ディレクトリに
`sessions/<sessionId>.json` として書き、既存の per-session dir
`display/<sessionId>/` と同じ root に共存させる。単一 `rm -rf` で
session が所有する全てが消える状態を保つ。

Entry の登録は `startXpra` の中で、xpra server と attach client の両方の
spawn が成功した後に `Effect.acquireRelease` で行う。release 側で
registry を削除するので、scope が正常に閉じれば entry は残らない。残っ
ているなら過去 run のクラッシュ跡と見なせる。

Stale 判定は xpra server pid の `kill -0` のみ。attach pid も一緒に記録
するのは、server が死んだ時に attach を念のため SIGTERM する用途のみで、
liveness 判定には使わない。判定を「metadata + live probe 併用」にしな
かったのは、entry を書く唯一の瞬間が "server spawn 成功 && attach spawn
成功" に揃っており、metadata と現実の差分が小さいから。GC は entry
ごとに server pid が死んでいれば attach pid を kill (best-effort)、
session dir を recursive 削除、X11 socket を削除、registry file を削除、
の順で進める。任意のステップが失敗しても残りは進める best-effort 方針。

副作用として `ProcessService.SpawnHandle` に `pid: number` を公開した。
また `isPidAlive(pid)` は `pid <= 0` を明示的に弾くようにした — `kill -0
0` はプロセスグループ全体へのシグナル送出になってしまい、`pid=0` sentinel
が常に alive と誤判定される罠を回避するため。

## Consequences
- xpra が起動するたび、過去のクラッシュ跡は自動で回収される。UI や CLI
  トップレベルに GC 呼び出しを追加する必要がない。
- Registry 書き込みは両方の spawn 成功後に限定される。途中で失敗すると
  entry は作られないので「未完成 entry」が生まれない代わり、
  部分起動後の孤児 (socket だけ残る等) は次回 xpra 起動まで残る。
- `ProcessService.SpawnHandle.pid` が interface に加わり、fake 実装は
  `pid: 0` を返す。`isPidAlive(0) === false` の guard と合わせて、fake
  から得た pid が誤って alive 扱いされない。
- Registry entry の削除は release path (scope 終了時) と GC path
  (他 run の孤児) の両方にあるが、どちらも `safeRemove` ベースで
  ENOENT を吞むので重複実行しても安全。
- Manual `nas display gc` サブコマンドは追加しない。必要になるまで
  runtime trigger で足りる。

## Rejected alternatives
- **Generic `runtime_registry.ts` の再利用**: network / hostexec 用の汎用
  registry は broker socket と pending request dir を前提に設計されて
  おり、display にはどちらも無い。継承しても使わないフィールドと概念
  を引き込むだけなので display 専用に書いた。
- **`DisplayRuntimeRegistryService` (Effect Service tag) を挟む**:
  consumer が `startXpra` 一箇所しかないため、DI 境界の旨味がなく
  StageServices union / `cli.ts` の Layer 構築を肥大化させるだけ。
  純 async 関数として呼ぶ。
- **`DisplayService` に `gcDisplay` / `cleanupDisplay` を公開**: 外部
  caller が存在しない以上、表面積を広げる理由がない。GC は
  `startXpra` 内部の implementation detail に閉じる。
- **`createDataContext` (UI) や CLI pre-pipeline からも GC 呼び出し**:
  "xpra を起こすパスが必ず先に GC を通る" を成立させるなら
  `startXpra` 一点で十分で、多点呼び出しは維持コストを増やすだけ。
- **metadata + live probe 併用の stale 判定**: entry が書かれる瞬間が
  "両方の spawn 成功後" に揃っているため metadata が現実から乖離する窓
  が小さい。現状は pid 単独で十分。probe が必要になるケース (file
  descriptor leak 等) が実測されたら再検討する。
