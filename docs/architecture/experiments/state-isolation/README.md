# srt と nas のエージェント状態の共有・分離実験

**srt と nas は、共有状態なら両者ともホストの履歴・memory を書き換えられ、状態を分離すると両者ともホスト側のデータを保持できた。** 分離は srt の書込許可設定と、nas の共有マウントを外す試作で実現した。

## 結果

仮のホスト状態と作業領域を用意し、隔離内の shell から memory・履歴を書き換えた。書込み後にホストから値を読み、変更が届いたかを確認した。

| 構成 | 専用の保存先への書込み | ホストの memory・履歴 |
| --- | --- | --- |
| srt: 状態を共有 | 成功（共有先） | 両方変更された |
| srt: 共有許可を残して保存先だけ変更 | 成功 | 両方変更された |
| srt: 元の状態を `allowWrite` から除外 | 成功 | 元の値を保持。直接書込みは拒否された |
| nas: 実装どおりの共有マウント | 成功（共有先） | 両方変更された |
| nas: 共有マウントを残して保存先だけ変更 | 成功 | 両方変更された |
| nas: 共有マウントを除去する試作 | 成功 | 元の値を保持。旧パスへの書込みはコンテナ専用領域に入った |

全6ケースで、保護した設定と領域外ファイルへの書込みは拒否された。通常の保存先へ書けることも確認し、ホスト側の値を保護の判定に使った。

`CLAUDE_CONFIG_DIR` は Claude Code の保存先を切り替える。元の共有先へのアクセス権はそのまま残るため、状態の分離には、srt では書込許可の変更、nas ではマウントの変更を組み合わせる。

## nas で変更したマウント

nas の実装が生成するマウント一覧から、次の RW 共有を外した。

- `~/.claude/projects`
- `~/.claude/file-history`
- `~/.claude/history.jsonl`
- `~/.claude.json`

設定の read-only mount とセッション専用の状態 root は残した。これにより、コンテナ内の旧パスへの書込みもセッション専用領域に収まった。この構成はマウント変更の試作であり、利用者向けの非共有設定として整備する段階が残っている。

## Claude Code の起動確認

両者の「保存先だけ変更」「非共有」の4ケースで、Claude Code を `--init-only` で起動した。全ケースで終了コード0、専用状態内への `.claude.json` の生成と SessionStart hook の印を確認した。[公式仕様](https://code.claude.com/docs/en/cli-reference)

srt では引数を `--` で区切り、Claude の `--settings` を子コマンドへ渡した。`CLAUDE_CODE_TMPDIR` は、比較の共通条件に合わせて作業領域の `.local/tmp` を指定した。初回の引数解釈エラーと `/tmp/claude` への書込エラー、および修正後の結果は観測データに記録した。

## 方法と確認範囲

srt は実物の CLI、nas は `prepareProtectedClaudeState` と `provisionClaude` が生成するマウントを適用した Docker container を使った。nas の設定は `protectSettings = true`、`shareCredentials = false` 相当とした。

ホスト状態には使い捨ての `synthetic-host/.claude`、専用状態には `work/.claude-state` を使った。対象はダミーの設定・履歴・memory で、確認範囲は filesystem の書込みと Claude の初期化である。認証、会話再開、汚染した memory に対するモデルの反応は、次の検証対象となる。

## 比較への反映

この実験が確認したのは、共有するホストファイルへの書込みを分離によって防げることまでである。専用の保存先でも、書き換えられた履歴や memory を次の実行で読めば影響を受ける。[比較文書](../../threat-model.md#被害防止と予防の比較)では、履歴や memory の改変を作業ファイルと同じ B2b に含め、保存先を分けたことだけでは加点しない。

## 書込み実験の再現

user namespace が使える Linux ホスト、Bun、Node、srt 0.0.77、bubblewrap、socat、キャッシュ済みの `nas-sandbox:latest` を使う。既存の [srt 実験](../srt-settings/README.md#再現)と同じ場所に srt を用意し、リポジトリ root で実行する。以下の runner を `node_modules/state-isolation-probe/run.ts` に保存する。`bwrap`・`socat` が PATH にない場合は、`STATE_PROBE_BWRAP`・`STATE_PROBE_SOCAT` に実体パスを渡す。

```sh
mkdir -p node_modules/state-isolation-probe
bun node_modules/state-isolation-probe/run.ts
```

NAS 内から実行する場合は最後の行を `hostexec bun node_modules/state-isolation-probe/run.ts` にする。Docker は `--network none`、srt は外向き通信の許可なしで動かす。結果を保存した後、仮のホスト状態と専用状態を削除する。Docker container は `--rm` で除去する。

<details>
<summary>書込み実験の runner</summary>

```ts
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareProtectedClaudeState, removeProtectedClaudeState } from '../../src/stages/mount/claude_state_fs.ts';
import { provisionClaude } from '../../src/agents/claude.ts';
const repo = process.cwd();
const output = resolve('node_modules/state-isolation-probe');
const scratch = await mkdtemp(join(output, 'fixture-'));
const bwrap = process.env.STATE_PROBE_BWRAP ?? Bun.which('bwrap');
if (!bwrap) throw new Error('bwrap is required');
const socat = process.env.STATE_PROBE_SOCAT ?? Bun.which('socat');
if (!socat) throw new Error('socat is required');
const srt = resolve('node_modules/threat-model-probe-runtime/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');
const env = { PATH: `${dirname(bwrap)}:${dirname(socat)}:${process.env.PATH}`, HOME: process.env.HOME!, USER: process.env.USER!, LANG: 'C.UTF-8' };
function run(argv: string[], options: any = {}) {
 const r = spawnSync(argv[0], argv.slice(1), {env, encoding:'utf8', timeout:60000, ...options});
 return {status:r.status, signal:r.signal, stdout:r.stdout ?? '', stderr:r.stderr ?? '', error:r.error?.message};
}
const report:any = { date:new Date().toISOString(), revision:run(['git','rev-parse','HEAD']).stdout.trim(), srt: JSON.parse(await readFile(join(dirname(srt), '../package.json'),'utf8')).version, docker:run(['docker','--version']).stdout.trim(), bwrap:run([bwrap,'--version']).stdout.trim(), image:'nas-sandbox:latest', imageId:run(['docker','image','inspect','nas-sandbox:latest','--format','{{.Id}}']).stdout.trim(), scope:'Direct filesystem operations by untrusted child processes; synthetic host state; actual srt CLI and production nas state mounts in Docker. No LLM or real credentials. nas nonshared is a mount-level prototype, not a supported profile.', cases:[] };
const script = `
set -eu
selected="$CLAUDE_CONFIG_DIR"
shared="$1"
guard="$2"
mkdir -p "$selected/projects/probe/memory"
normal=false
if printf 'selected-write' > "$selected/projects/probe/memory/MEMORY.md"; then normal=true; fi
memory=false
if (mkdir -p "$shared/projects/probe/memory" && printf 'direct-memory' > "$shared/projects/probe/memory/MEMORY.md") 2>/dev/null; then memory=true; fi
history=false
if (printf 'direct-history' > "$shared/history.jsonl") 2>/dev/null; then history=true; fi
settings=false
if (printf 'changed-settings' > "$shared/settings.json") 2>/dev/null; then settings=true; fi
outside=false
if (printf 'changed-guard' > "$guard") 2>/dev/null; then outside=true; fi
printf '{"normalWrite":%s,"directMemoryWrite":%s,"directHistoryWrite":%s,"settingsWrite":%s,"outsideWrite":%s}\\n' "$normal" "$memory" "$history" "$settings" "$outside"
`;
try {
 for (const runtime of ['srt','nas']) for (const mode of ['shared','redirect-only','nonshared']) {
  const name = `${runtime}-${mode}`;
  const dir = join(scratch,name), work = join(dir,'work'), fixtureHome = join(dir,'synthetic-host');
  const shared = join(fixtureHome,'.claude');
  await mkdir(join(shared,'projects/probe/memory'),{recursive:true});
  await mkdir(join(work,'.claude-state/projects/probe/memory'),{recursive:true});
  await mkdir(join(work,'.claude'),{recursive:true});
  await writeFile(join(shared,'projects/probe/memory/MEMORY.md'),'original-memory');
  await writeFile(join(shared,'history.jsonl'),'original-history');
  await writeFile(join(shared,'settings.json'),'{}');
  await writeFile(join(fixtureHome,'.claude.json'),'{}');
  const guard = join(dir,'host-guard'); await writeFile(guard,'original-guard');
  await writeFile(join(work,'probe.sh'),script);
  let state:any;
  let result:any;
  let mounts:any;
  let settings:any;
  try {
   if (runtime === 'srt') {
    settings = {network:{allowedDomains:[],deniedDomains:[]},filesystem:{allowWrite:[work,...(mode==='nonshared'?[]:[shared])],denyWrite:[join(shared,'settings.json'),join(work,'.claude')],denyRead:[]}};
    await writeFile(join(dir,'srt.json'),JSON.stringify(settings));
    const selected=mode==='shared'?shared:join(work,'.claude-state');
    result=run(['node',srt,'--settings',join(dir,'srt.json'),'/bin/sh',join(work,'probe.sh'),shared,guard],{cwd:work,env:{...env,CLAUDE_CONFIG_DIR:selected}});
   } else {
    state=await prepareProtectedClaudeState(fixtureHome,{protectSettings:true,shareCredentials:false});
    const provision=provisionClaude({hostHome:fixtureHome,containerHome:'/probe-home',protectSettings:true,protectedClaudeState:state,probes:{claudeDirExists:true,claudeJsonExists:true,claudeBinPath:null,claudeSettingsFiles:['settings.json']},priorDockerArgs:[],priorEnvVars:{},mountHostBinary:false});
    mounts=provision.mounts!;
    if(mode==='nonshared') mounts=mounts.filter((m:any)=>m.source===state.runtimeDir || m.readOnly);
    const selected=mode==='shared'?'/probe-home/.claude':'/work/.claude-state';
    const args=['docker','run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${process.getuid!()}:${process.getgid!()}`,'--workdir','/work','--entrypoint','/bin/sh','--mount',`type=bind,src=${work},dst=/work`,'--mount',`type=bind,src=${guard},dst=/host-guard,readonly`,'--env',`CLAUDE_CONFIG_DIR=${selected}`];
    for(const m of mounts) args.push('--mount',`type=bind,src=${m.source},dst=${m.target}${m.readOnly?',readonly':''}`);
    args.push(report.image,'/work/probe.sh','/probe-home/.claude','/host-guard');
    result=run(args);
   }
   const memory=await readFile(join(shared,'projects/probe/memory/MEMORY.md'),'utf8');
   const history=await readFile(join(shared,'history.jsonl'),'utf8');
   const normalPath=mode==='shared'?join(shared,'projects/probe/memory/MEMORY.md'):join(work,'.claude-state/projects/probe/memory/MEMORY.md');
   const item={name, mode, runtime, result, child: result.status===0?JSON.parse(result.stdout.trim()):null, hostMemory:memory,hostHistory:history,hostSettings:await readFile(join(shared,'settings.json'),'utf8'),hostGuard:await readFile(guard,'utf8'),selectedState:await readFile(normalPath,'utf8').catch(()=>null),settings,mounts};
   report.cases.push(item);
   console.log(JSON.stringify({name,status:result.status,child:item.child,hostMemory:memory,hostHistory:history,selectedState:item.selectedState,stderr:result.stderr.slice(0,180)}));
  } finally { if(state) await removeProtectedClaudeState(state); }
 }
} finally {
 await rm(scratch,{recursive:true,force:true});
 report.cleaned=true;
 const text=JSON.stringify(report,null,2).replaceAll(scratch,'<scratch>').replaceAll(repo,'<repo>').replaceAll(/\/tmp\/nas-claude-state-[A-Za-z0-9]+/g,'<runtime-state>');
 await writeFile(join(output,'results.json'),text+'\n');
}
```

</details>

起動確認では、各 fixture の `.claude-state` と `.local/tmp` を作り、次の明示設定を `startup.json` に保存した。

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "printf startup-ok > \"$CLAUDE_CONFIG_DIR/startup-marker\""
      }]
    }]
  }
}
```

runner の shell 呼出しを次の Claude 起動に置き換え、終了後に `.claude-state/.claude.json` の存在と `startup-marker` の値 `startup-ok` を確認した。nas 側では実体に解決したホストの Claude binary を read-only mount し、同じ引数で起動した。

```sh
CLAUDE_CONFIG_DIR="$PWD/.claude-state" \
CLAUDE_CODE_TMPDIR="$PWD/.local/tmp" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_AUTOUPDATER=1 \
ANTHROPIC_API_KEY=state-probe-dummy \
ANTHROPIC_BASE_URL=http://127.0.0.1:1 \
node /path/to/srt/dist/cli.js --settings /path/to/srt.json -- \
  /path/to/claude --init-only --setting-sources '' --settings "$PWD/startup.json"
```
