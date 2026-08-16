# hostexec stdin FD passing

## Purpose

hostexec の container-side client は、broker に request を送る前に fd 0 を
読み切り、base64 にして initial JSON request へ載せている。この eager capture
は command が stdin を読まない場合でも pipe を消費するため、通常の Unix
process と異なる結果を作る。

```bash
printf payload | { intercepted-no-read; cat; }
```

通常は最初の command が何も読まないので `cat` が `payload` を受け取る。しかし
現在の hostexec client は先に `payload` を吸い上げ、host command が読まなくても
後続の `cat` には何も残さない。slow producer は fixed wait window の後に来た入力を
失い、idle-but-open pipe は interception ごとに待ち時間も発生させる。

この変更では stdin の byte snapshot を廃止し、Linux Unix-domain socket の
`SCM_RIGHTS` で stdin の open file description を host-side process へ渡す。
対応する fd class では、host command が実際に読んだ量だけが消費される Unix
semantics を bare-command client と LD_PRELOAD `exec*` の両方で保存する。

## Success Criteria

- read-only、非 TTY の fd 0 は client が一切 read せず host command へ渡す。
- host command が stdin を読まなければ、同じ shell の後続 reader が全入力を
  読める。
- host command が一部だけ読めば、後続 reader が残りを読める。
- slow producer と large input は timeout や全量 user-space buffering なしで
  kernel backpressure に従う。
- broker の明示 fallback は、未消費の元 fd 0 を local command に引き継ぐ。
- transport、protocol、spawn、mask-filter の失敗は local execution へ fallback
  せず fail-closed にする。
- host command の stdout/stderr は引き続き TypeScript broker の mask-filter を
  通った後だけ container へ返す。
- bare-command client と LD_PRELOAD `exec*` に同じ request transport を使う。

## Supported FD Boundary

FD number 自体を container と host の間で保存するわけではない。Linux kernel は
`SCM_RIGHTS` で受け取った open file description への参照を gateway process の
fd table に新しい番号で作る。Docker container と host process は同じ Linux
kernel 上にいるため、mount / PID / user namespace をまたいでも同じ pipe endpoint
や regular-file offset を共有できる。

FD passing の対象は次の条件をすべて満たす fd 0 に限定する。

- `isatty(fd) == false`
- `F_GETFL & O_ACCMODE == O_RDONLY`
- LD_PRELOAD 経路では、呼び出し元が command image へ置き換わる `exec*` hook

通常の pipeline、input redirection、here document、process substitution はこの
範囲に入る。

次は対象外とする。

- TTY: 現行どおり forwarding しない。
- `O_WRONLY`: stdin として読めないため forwarding しない。
- `posix_spawn*`: file actions を解釈せずに caller の fd 0 を移譲すると、spawn 後も
  実行を続ける caller の入力を別 process に渡してしまうため forwarding しない。
- `O_RDWR`: fail-closed にする。socketpair 等を stdin に置くと host command が
  fd 0 へ書き戻せる。secret env を持つ host command に unmasked な host-to-
  container channel を与え、stdout/stderr mask-filter を迂回できるためである。
- Docker Desktop、remote Docker、その他 broker と container が別 kernel にいる
  runtime: `SCM_RIGHTS` は kernel boundary を越えられない。

TTY、closed fd、`O_WRONLY`、`posix_spawn*` は request の `stdinMode` を `none` に
する。非 TTY の `O_RDWR` は silent degradation せず、理由を stderr に出して
request を送る前に失敗する。

## Architecture

セッションごとに host-side の `nas-hostexec-gateway` を一つ起動する。gateway は
Zig で実装し、container-visible exec socket、received FD、host command process を
所有する。既存 TypeScript broker は policy、approval、integrity、audit、secret
resolution、output masking を所有し続ける。

```text
container
  nas-hostexec-client / LD_PRELOAD interceptor
                 │ execute request + SCM_RIGHTS(fd 0)
                 ▼
host
  nas-hostexec-gateway
                 │ metadata / execution control / raw output
                 ▼
  TypeScript HostExecBroker
                 ├─ rule / approval / integrity / audit
                 ├─ secret env resolution
                 └─ stdout/stderr mask-filter
```

### Container-side Zig clients

`protocol.zig` は fd 0 を分類し、supported FD なら request の最初の write を
`sendmsg` で行う。client 自身は stdin を poll / read / encode しない。

standalone client は broker が明示 fallback を返した場合だけ PATH 上の real
binary を `exec` する。元の fd 0 は一度も読まれていないのでそのまま使える。
LD_PRELOAD interceptor も明示 fallback では元の `exec*` を呼び、同じ fd 0 を
command image に引き継ぐ。

### Zig gateway

gateway は現在 container に mount されている external exec socket を listen
する。request ごとに connection と received FD を保持し、host-only internal
socket で TypeScript broker と接続する。

TypeScript broker が execution spec を返すまで command を spawn せず、FD も
read しない。許可後は received FD を child stdin に設定し、resolved argv、cwd、
env で host command を独立 process group として起動する。stdout/stderr は raw
chunk として TypeScript broker へ送り、broker から戻った masked chunk だけを
external client へ転送する。

gateway は raw output、command env、secret values をログへ出さない。diagnostics
対象は request ID、PID、exit reason、byte count に限定する。

### TypeScript broker

TypeScript broker は host-only internal exec socket と既存 control socket を
listen する。external request の rule matching、approval、integrity check が
完了した後、resolved argv / cwd / env を execution spec として gateway に返す。

gateway から受け取った fd 1 / fd 2 の raw chunk は、それぞれ既存 mask-filter
subprocess に入力する。filter の stdout から得た bytes だけを masked chunk として
gateway に返す。command exit と両 stream の EOF を受けた後に filter を flush し、
filter が正常終了して初めて terminal result を返す。

### Stage and service boundary

`HostExecBrokerService` は TypeScript broker と gateway を一つの scoped session
resource として管理する。stage は pure planner と `HostExecBrokerService.start()`
だけを呼び、process spawn、socket readiness、cleanup を記述しない。

gateway binary の host path は client / interceptor artifacts と同様に pipeline
startup probe で解決する。planner は解決済み path を受け取り、artifact の存在を
filesystem へ問い合わせない。

## Socket Boundaries

セッションは三つの socket boundary を持つ。

1. **External exec socket** — gateway が listen し、container にはこの socket の
   directory だけを mount する。`execute` protocol だけを受理する。
2. **Internal gateway/broker socket** — TypeScript broker が listen し、session
   broker directory の host-only 部分に置く。container へ mount しない。
3. **Control socket** — 既存どおり host-side CLI/UI 専用とし、approve、deny、
   list-pending だけを受理する。

internal socket と control socket を external exec directory の外に置くことで、
container process が approval や execution spec を偽造できないようにする。

## External Protocol Version 2

Initial request から base64 stdin field を削除し、stdin transport を明示する。

```ts
interface ExecuteRequestV2 {
  version: 2;
  type: "execute";
  sessionId: string;
  requestId: string;
  argv0: string;
  args: string[];
  cwd: string;
  tty: boolean;
  stdinMode: "fd" | "none";
}
```

`stdinMode: "fd"` の request は initial JSON line と fd 0 を一回の `sendmsg` で
送る。stream socket の partial write が起きた場合、ancillary data は最初の
successful write にだけ添付し、残りの bytes は通常の write loop で送る。

gateway は最初の read を `recvmsg(MSG_CMSG_CLOEXEC)` で行い、ancillary data と
JSON prefix を同時に受け取る。JSON line が分割されていれば通常の read で完成
させる。次を protocol error として拒否し、受け取った全 FD を close する。

- `stdinMode: "fd"` なのに FD が正確に一つでない
- `stdinMode: "none"` なのに FD が添付されている
- ancillary data が truncated している
- ancillary type が `SCM_RIGHTS` でない
- FD が TTY、`O_RDWR`、`O_WRONLY`、または検査不能
- request が 4 MiB を超える
- protocol version または message type が未知
- request の session ID が gateway の session と一致しない

external response は既存の NDJSON `chunk` / `result` / `error` / `fallback` を維持
する。client と gateway は同じ nas package から配布するため、version 1 との
compatibility mode は設けない。version mismatch は fail-closed にする。

## Internal Protocol and State Machine

gateway は external request ごとに一本の internal connection を開く。双方向
NDJSON で次の message を交換する。

Gateway to broker:

- `execute`: external metadata。FDそのものは含めない。
- `spawned`: host command PID。
- `raw_chunk`: fd 1 / fd 2、最大 64 KiB の base64 bytes。
- `process_exit`: command exit code と両 raw stream の EOF。
- `cancelled` / `transport_error`: gateway-side termination reason。

Broker to gateway:

- `fallback` / `error`: spawn 前の terminal decision。
- `start`: resolved argv、cwd、env を含む execution spec。
- `masked_chunk`: client へ転送可能な fd 1 / fd 2 の bytes。
- `result`: mask-filter flush 後の terminal exit code。
- `kill`: active command group の停止要求。

raw と masked chunk は最大 64 KiB とし、internal control message 全体は 4 MiB を
上限にする。各方向で許可された message type を state ごとに限定し、gateway は
container 由来の未知messageをinternal socketへopaque forwardingしない。

```text
client       gateway             TypeScript broker
  │ execute+fd │                         │
  ├───────────>│ execute metadata        │
  │            ├────────────────────────>│ rule / approval
  │            │<──────── start ─────────┤
  │            │ spawn(fd -> stdin)      │
  │            ├──────── spawned ───────>│ diagnostics
  │            ├──────── raw_chunk ─────>│ mask-filter
  │            │<────── masked_chunk ────┤
  │<── chunk ──┤                         │
  │            ├──────── process_exit ──>│ filter flush
  │            │<──────── result ────────┤
  │<── result ─┤                         │
```

approval 待ち中、gateway は external connection と received FD を保持するだけで
read しない。producer が pipe capacity まで書いて block する場合、それは通常の
consumer がまだ stdin を読んでいない場合と同じ kernel backpressure である。

`fallback` は `start` より前にだけ有効とする。gateway は received FD の複製を
close し、client は元の未消費 fd 0 で local command を実行する。`start` 後の
fallback は protocol violation であり、command を停止して fail-closed にする。

## Failure and Cleanup

各 host command は独立 process group で起動する。direct child だけでなく、その
command が起動した descendant も request lifecycle に従わせるためである。

- **Client disconnect** — gateway は command group に SIGTERM を送り、短い猶予後
  SIGKILL する。broker へ cancel を通知し、broker は mask-filter を停止する。
- **Internal broker disconnect** — gateway は raw output を external client へ流さず
  command group を停止する。
- **Gateway disconnect** — broker は request の mask-filter を停止する。client は
  terminal response なしを transport failure として扱い、local fallback しない。
- **Mask-filter failure** — broker は gateway に kill を要求し、terminal error を
  返す。command 終了後に判明した場合も実 command の zero exit を success として
  報告しない。
- **Spawn failure** — gateway は broker へ error を返す。broker は audit / masked
  diagnostic を経て terminal error にし、local fallback は許可しない。
- **Approval pending at shutdown** — gateway connection と received FD を close し、
  pending entry と waiter を削除する。
- **Normal completion** — command exit、raw stream EOF、mask-filter flush、result の
  順を保証する。

session startup は次の順に行う。

1. TypeScript broker が internal socket と control socket を開始する。
2. service が gateway を起動する。
3. gateway protocol handshake で readiness を確認する。
4. external exec socket が ready になった後に stage startup を完了する。

teardown は gateway の accept 停止、active command / FD cleanup、gateway exit、
broker cleanup の順とする。異常終了でも socket、process、FDを残さない。

## Security Constraints

- **C1 / S1** — secret env と mask secret frame は host process だけが扱う。secret
  env は host-only internal socket で gateway へ渡すが、container filesystem、
  external response、gateway log には出さない。
- **C2** — container に mount するのは gateway の external exec socket directory
  だけであり、control/internal socket は公開しない。
- **C3** — gateway は raw stdout/stderr を external client へ送れない state machine
  とする。client へ送る data frame は broker の `masked_chunk` からだけ生成する。
- **N1** — container/host communication は既存どおり明示的に mount された Unix
  socket に限定する。TCP listener は追加しない。
- **Bidirectional FD defense** — `O_RDWR` fd 0 を拒否し、host command が secret を
  stdin descriptor 経由でcontainerへ書き戻す経路を作らない。

gateway は通常の nas user として実行し、追加 capability や root privilege を
要求しない。

## Testing Strategy

### Zig unit tests

- request framing の partial send / receive
- `SCM_RIGHTS` 付きrequestとFDなしrequest
- FDなし、複数FD、unknown ancillary、`MSG_CTRUNC` の拒否とclose
- TTY、`O_RDONLY` pipe/file、`O_RDWR` socketpair、`O_WRONLY` の分類
- `MSG_CMSG_CLOEXEC` によりreceived FDへclose-on-execが付くこと
- received FDをchild stdinへ設定したspawnとprocess-group cleanup
- protocol stateごとのmessage direction validation

### TypeScript unit tests

- execute metadataからfallback / error / startへの分岐
- approval pending中にinternal connectionを保持すること
- raw fd 1 / fd 2 chunkを別々のmask-filterへ送ること
- raw EOF後にfilterをflushしてからresultを返すこと
- filter failure、gateway cancel、broker shutdownのcleanup
- stage plannerがprobe済みgateway artifact pathだけを使うこと
- broker serviceがreadinessとteardownを正しい順で行うこと

### Host-native integration tests

real client、interceptor、gateway、brokerを使い、少なくとも次を検証する。

```bash
printf payload | { intercepted-no-read; cat; }
```

- bare-command client と LD_PRELOAD `exec*` の双方で後続 `cat` が `payload` を読む
- host commandが全量または一部を読んだ場合だけそのbytesが消費される
- 250msを超えるslow producerがtruncationなしでhost commandへ届く
- large inputが全量client/gateway bufferなしで完了する
- explicit fallback後にlocal commandが元のstdinを読む
- approval前にpipe内容が消費されない
- broker/gateway failureはstdinを消費せずfail-closed
- `O_RDWR` socketpairが明示的に拒否される
- client disconnectでhost process groupが残らない
- split chunkをまたぐsecretがmaskedされ、raw bytesがclientへ出ない

既存のtest-side Zig buildと明示skip diagnosticをgateway artifactにも適用する。

### Docker and packaging tests

- bind-mounted external Unix socketを通じ、container processからhost gatewayへ
  `SCM_RIGHTS`を渡せることをDocker integrationで一件確認する。
- Zig buildがclient、interceptor、gatewayを生成することを確認する。
- Nix hostexec derivationとnas asset bundleへgatewayを含める。
- Docker不要のZig testsとhost-native regressionをPR CIで実行する。Docker caseは
  integration環境で実行する。

### Test ownership and consolidation

各security・lifecycle不変条件には、それを最も直接観測するtestを一つownerとして
置く。unit、host-native integration、Docker E2Eの複数層が同じ内部経路と結果だけを
繰り返す場合は、境界をまたぐ代表的なproofを残し、それ以外を重複coverageとして
統合する。

- bare clientとLD_PRELOAD interceptorは異なるentry pointなので、双方の代表的な
  end-to-end proofを残す。
- protocol validation、FD ownership、fail-closed、process-group cleanup、shutdown、
  backpressure、maskingには少なくとも一つの直接testを残す。
- test harness自身のfault injectionを検証するtestは置かない。production invariantを
  観測しないfixture、fault hook、process probeは削除する。
- listener fault branch、forced shutdown ownership simulation、fake child cleanup hookは
  production lifecycleのownerではないため削除し、実際のcooperative cleanup testをownerとして残す。
- production state machine、timeout、signal処理の簡略化をtest削減の根拠にしない。
- 同じlifecycleを入力値だけ変えて繰り返す場合はtable-driven testへまとめる。

## Non-Goals

- TTY / PTY forwarding とjob control
- `posix_spawn*` file actions の解釈
- stdin以外の任意FD forwarding
- `O_RDWR` stdinのsemantics保存
- 別kernel/VM/remote daemon境界を越えるFD transport
- transport failure時のlocal fallback
- protocol version 1との互換mode
- hostexec control protocol全体のschema hardening

## Why — なぜこのアプローチを選んだか

byte relayは、relay processが元fdから読み出した時点で後続readerからbytesを奪う。
backpressureを使ってもuser-spaceやkernel pipeのbuffer分は先読みされるため、host
commandが実際に読んだ量だけを消費するUnix semanticsを厳密には再現できない。
同じopen file descriptionをhost childへ渡すFD passingだけが、no-read、partial-
read、slow producer、large inputを同じ仕組みで扱える。

native処理をper-session Zig gatewayへ隔離するのは、`SCM_RIGHTS`、process-group
ownership、FD cleanupを明示的なLinux boundaryへ閉じるためである。TypeScript
brokerにpolicy、approval、secret resolution、maskingを残すことで、既存のsecurity
判断をnative codeへ複製せず、control socket分離とoutput maskingを維持できる。

per-session processはglobal daemonよりprocess数が増えるが、socket、pending FD、
host command、cleanupをsession scopeに一致させられる。別sessionのrequestやsecret
を同じnative stateへ混在させないことを優先する。

## Why Not — なぜ他の案を選ばなかったか

- **Metadata判定後のstdin relay** — rule不一致やbroker障害の前にstdinを消費する
  問題と250ms待ちは解消できる。しかしallow後のrelayがbytesを先読みするため、
  no-read / partial-read semanticsを満たさない。
- **Bun process内のZig FFI transport** — received FDを既存`Bun.spawn`へ直接渡せる
  ためdiffは小さい。一方、blocking `recvmsg` worker、process-wide FD番号のthread
  間受け渡し、既存fdからの`net.Socket`生成にBun runtime固有の前提が集中する。
  runtime更新に弱いnative boundaryより、独立processの明示的protocolを選ぶ。
- **Global Zig gateway** — process数は減るが、全sessionのexternal sockets、FD、
  command、secret-bearing execution specを一つのlong-lived processが管理することに
  なる。session isolationとteardownの単純さを優先し、per-sessionとする。
- **`O_RDWR` FDも許可する** — socketpair等を通じてhost commandがfd 0へ書き戻せ、
  stdout/stderr mask-filterを迂回するhost-to-container channelになる。exact semantics
  よりsecurity invariant C3を優先して拒否する。
- **FDをread-onlyでreopenする** — `/proc/<pid>/fd/<n>`等から開き直せるfile typeも
  あるが、新しいopen file descriptionになる場合はoffsetを共有せず、対象によって
  動作も異なる。securityとsemanticsの両方を一貫して満たさない。
