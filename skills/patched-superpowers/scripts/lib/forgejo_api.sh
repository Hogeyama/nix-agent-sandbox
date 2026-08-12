#!/usr/bin/env bash
# Forgejo の API と web エンドポイントの薄いラッパ。
#
# 既存スレッドへの返信と resolve は公開 API に無いので web エンドポイントを使う。
# 文書化されていない経路なので、request-review の初期化時にスモークテストで
# 疎通を確かめる。

fj_api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" \
    -H "Authorization: token $(fj_token)" \
    -H 'Content-Type: application/json' \
    "http://localhost:$(fj_port)/api/v1$path" "$@"
}

fj_login_agent() {
  local jar
  jar="$(fj_run_dir)/cookies-agent"
  [ -s "$jar" ] && return 0
  fj_credentials
  # Forgejo 16 のログインフォームは CSRF トークンを要求しない。
  curl -sS -c "$jar" -o /dev/null \
    -d "user_name=agent&password=$FJ_AGENT_PASS" \
    "http://localhost:$(fj_port)/user/login"
  [ -s "$jar" ] || { fj_die "agent のログインに失敗した"; return 1; }
}

# web エンドポイントを叩き、HTTP ステータスだけを出力する。
fj_web() {
  local method="$1" path="$2"
  shift 2
  fj_login_agent || return 1
  curl -sS -X "$method" -b "$(fj_run_dir)/cookies-agent" -o /dev/null -w '%{http_code}' \
    "http://localhost:$(fj_port)$path" "$@"
}

# 返信と resolve は文書化されていない web エンドポイントに依存するため、Forgejo の
# バージョン更新で壊れうる。壊れたまま進むと、指摘に返信できないままレビューが
# 成立したように見える。スクラッチリポジトリで1往復して疎通を確かめ、駄目ならその場で
# 止める。起動が1秒台なので毎回実行しても支障はない。
#
# FJ_SMOKE_REPLY_PATH はテストで経路を差し替えるためにだけ使う。
fj_smoke() {
  local repo=agent/_forgejow_smoke work rc=0 head_sha pr rid cid before after code resolver url
  fj_api DELETE "/repos/$repo" >/dev/null 2>&1
  fj_api POST /user/repos -d '{"name":"_forgejow_smoke","auto_init":false,"private":true}' \
    >/dev/null || { fj_die "スモーク用リポジトリを作れない"; return 1; }

  # push 先の URL は cd する前に確定させる。fj_run_dir はカレントのリポジトリの
  # パスから引くので、別リポジトリに cd した後ではポートもトークンも取れない。
  url="http://agent:$(fj_token)@localhost:$(fj_port)/$repo.git"
  work="$(mktemp -d)"
  (
    set -e
    cd "$work"
    git init -q -b main
    git config user.email smoke@review.invalid
    git config user.name smoke
    git config commit.gpgsign false
    printf 'a\n' >f.txt
    git add -A && git commit -qm base
    git push -q -f "$url" HEAD:refs/heads/smoke-base
    printf 'a\nb\n' >f.txt
    git add -A && git commit -qm change
    git push -q -f "$url" HEAD:refs/heads/smoke-head
  ) >/dev/null 2>&1 || rc=1
  head_sha="$(git -C "$work" rev-parse HEAD 2>/dev/null)"
  rm -rf "$work"
  if [ "$rc" != 0 ]; then
    fj_api DELETE "/repos/$repo" >/dev/null 2>&1
    fj_die "スモークの push に失敗した"
    return 1
  fi

  for _ in $(seq 1 40); do
    fj_api GET "/repos/$repo/branches/smoke-head" | jq -e '.name' >/dev/null 2>&1 && break
    sleep 0.25
  done

  pr="$(fj_api POST "/repos/$repo/pulls" \
    -d '{"head":"smoke-head","base":"smoke-base","title":"smoke","body":"smoke"}' |
    jq -r '.number // empty')"
  if [ -z "$pr" ]; then
    fj_api DELETE "/repos/$repo" >/dev/null 2>&1
    fj_die "スモーク用 PR を作れない"
    return 1
  fi
  rid="$(fj_api POST "/repos/$repo/pulls/$pr/reviews" \
    -d '{"event":"COMMENT","comments":[{"path":"f.txt","new_position":2,"body":"smoke"}]}' |
    jq -r '.id // empty')"
  cid="$(fj_api GET "/repos/$repo/pulls/$pr/reviews/$rid/comments" | jq -r '.[0].id // empty')"
  if [ -z "$rid" ] || [ -z "$cid" ]; then
    fj_api DELETE "/repos/$repo" >/dev/null 2>&1
    fj_die "スモーク用のレビューコメントを作れない"
    return 1
  fi
  before="$(fj_api GET "/repos/$repo/pulls/$pr/reviews/$rid/comments" | jq 'length')"

  code="$(fj_web POST "${FJ_SMOKE_REPLY_PATH:-/$repo/pulls/$pr/files/reviews/comments}" \
    --data-urlencode "origin=diff" \
    --data-urlencode "latest_commit_id=$head_sha" \
    --data-urlencode "side=proposed" \
    --data-urlencode "line=2" \
    --data-urlencode "path=f.txt" \
    --data-urlencode "reply=$rid" \
    --data-urlencode "content=smoke reply")"
  after="$(fj_api GET "/repos/$repo/pulls/$pr/reviews/$rid/comments" | jq 'length')"
  if [ "$after" -le "$before" ]; then
    fj_api DELETE "/repos/$repo" >/dev/null 2>&1
    fj_die "返信のエンドポイントが機能しない (HTTP $code)。forgejo $(fj_version) で経路が変わった可能性がある"
    return 1
  fi

  code="$(fj_web POST "/$repo/issues/resolve_conversation" \
    --data-urlencode "origin=diff" --data-urlencode "action=Resolve" \
    --data-urlencode "comment_id=$cid")"
  resolver="$(fj_api GET "/repos/$repo/pulls/$pr/reviews/$rid/comments" |
    jq -r '.[0].resolver.login // "null"')"
  fj_api DELETE "/repos/$repo" >/dev/null 2>&1
  if [ "$resolver" = null ]; then
    fj_die "resolve のエンドポイントが機能しない (HTTP $code)。forgejo $(fj_version) で経路が変わった可能性がある"
    return 1
  fi
}

fj_version() { forgejo --version | awk '{print $3}'; }

fj_repo_name() { basename "$(fj_repo_root)"; }

fj_ensure_repo() {
  local name owner=agent
  name="$(fj_repo_name)"
  if ! fj_api GET "/repos/$owner/$name" | jq -e '.id' >/dev/null 2>&1; then
    # private にするのは匿名閲覧を閉じるためである。インスタンスは
    # REQUIRE_SIGNIN_VIEW = false で動かしているので、public にすると localhost の
    # ポートに届く任意のリクエストがユーザーのソースを読める。
    fj_api POST /user/repos \
      -d "$(jq -nc --arg n "$name" '{name: $n, auto_init: false, private: true}')" \
      >/dev/null
    # reviewer が自分のスレッドを resolve するには write 権限が必要になる。
    # Forgejo は resolve ボタンの表示条件に write を要求する。
    fj_api PUT "/repos/$owner/$name/collaborators/reviewer" \
      -d '{"permission":"write"}' >/dev/null
  fi
  echo "$owner/$name"
}

fj_push_url() {
  echo "http://agent:$(fj_token)@localhost:$(fj_port)/$(fj_ensure_repo).git"
}

# base をレビュー用のブランチとして、head を作業ブランチ名で push する。
# 実リポジトリに remote を追加しないため URL を直接指定する。レビュー用の
# 一時的な forge がユーザーの git config に痕跡を残さないようにする。
fj_push_range() {
  local range="$1" base head branch url run
  base="$(git rev-parse "${range%%..*}")" || { fj_die "base ref を解決できない: $range"; return 1; }
  head="$(git rev-parse "${range##*..}")" || { fj_die "head ref を解決できない: $range"; return 1; }
  branch="$(git symbolic-ref -q --short HEAD || echo review-head)"
  url="$(fj_push_url)"
  git push -q -f "$url" "$base:refs/heads/review-base" ||
    { fj_die "base の push に失敗した"; return 1; }
  git push -q -f "$url" "$head:refs/heads/$branch" ||
    { fj_die "head の push に失敗した"; return 1; }
  run="$(fj_run_dir)"
  echo "$branch" >"$run/branch"
  echo "$base" >"$run/base"
  echo "$head" >"$run/head"

  # push の完了と DB への反映は同期しない。反映前のリポジトリは empty 扱いのままで
  # PR 系のエンドポイントが 404 を返すので、ブランチが見えるまで待つ。
  fj_wait_branch review-base || return 1
  fj_wait_branch "$branch" || return 1
}

# 修正コミットを push する。前回 push した head から HEAD までを新規分として報告
# する。Forgejo は PR head を即座に追随させ、修正コミット自体が同じ PR のレビュー
# 対象コミットとして加わるので、レビュー用の URL を貼り直す必要がない。
fj_push_head() {
  local run prev head branch
  run="$(fj_run_dir)"
  prev="$(cat "$run/head")"
  head="$(git rev-parse HEAD)"
  branch="$(fj_branch)"
  git push -q -f "$(fj_push_url)" "HEAD:refs/heads/$branch" ||
    { fj_die "push に失敗した"; return 1; }
  echo "$head" >"$run/head"
  [ "$prev" = "$head" ] && return 0
  fj_wait_commit_in_pr "$head" || return 1
  git log --reverse --format='%h' "$prev..$head"
}

# push した head が PR に反映されるまで待つ。反映前に URL を返すと、ユーザーが開いた
# ときにその修正コミットがまだ PR に無い。
#
# head.sha の一致では足りない。PR の head が更新された後もコミット一覧の反映は
# 遅れるため、一覧に現れることまで確かめる。ユーザーが見るのは一覧の側である。
fj_wait_commit_in_pr() {
  local sha="$1" repo pr
  repo="$(fj_ensure_repo)"
  pr="$(fj_pr_num)"
  for _ in $(seq 1 40); do
    fj_api GET "/repos/$repo/pulls/$pr/commits?limit=100" |
      jq -e --arg s "$sha" 'type == "array" and any(.[]; .sha == $s)' >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  fj_die "push した $sha が PR のコミット一覧に現れない"
}

fj_wait_branch() {
  local branch="$1" repo
  repo="$(fj_ensure_repo)"
  for _ in $(seq 1 40); do
    fj_api GET "/repos/$repo/branches/$branch" | jq -e '.name' >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  fj_die "ブランチ $branch が Forgejo 側に現れない"
}

fj_branch() { cat "$(fj_run_dir)/branch"; }

fj_ensure_pr() {
  local repo branch existing
  repo="$(fj_ensure_repo)"
  branch="$(fj_branch)"
  existing="$(fj_api GET "/repos/$repo/pulls?state=open" |
    jq -r --arg b "$branch" 'map(select(.head.ref == $b)) | .[0].number // empty')"
  if [ -n "$existing" ]; then
    echo "$existing"
    return 0
  fi
  fj_api POST "/repos/$repo/pulls" \
    -d "$(jq -nc --arg b "$branch" '{head: $b, base: "review-base",
          title: "実装ブランチのレビュー", body: "patched-superpowers Phase 3"}')" |
    jq -r '.number'
}

fj_pr_num() { cat "$(fj_run_dir)/pr"; }

# PR の作成直後は Forgejo が patch check を非同期で走らせるため、commits などの
# エンドポイントが一時的に 404 を返す。ここで待たないと、直後にレビュー対象を
# 参照する処理が対象を見つけられずに失敗する。
fj_wait_pr_ready() {
  local pr="$1" repo
  repo="$(fj_ensure_repo)"
  for _ in $(seq 1 40); do
    if fj_api GET "/repos/$repo/pulls/$pr/commits" | jq -e 'type == "array"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  fj_die "PR $pr が準備できない"
}

fj_pr_url() {
  echo "http://localhost:$(fj_port)/$(fj_ensure_repo)/pulls/$(fj_pr_num)"
}

fj_commit_url() {
  echo "$(fj_pr_url)/commits/$1"
}

# 返信は公開 API では作れない。同じ path/line に API で投稿すると会話が review 単位
# で分かれるため別スレッドとして表示されてしまう。web エンドポイントに
# reply=<review_id> を渡して同一スレッドに入れる。
#
# path と line には API が返した path と position をそのまま渡す。position は diff 内の
# 位置であってファイル行番号ではないため、行番号を計算して渡すと 500 になる。省略
# しても検証で弾かれる。side は proposed / previous のみを受け付ける。
fj_reply() {
  local tid="$1" body="$2" t code
  t="$(fj_threads | jq -c --argjson id "$tid" '.[] | select(.thread_id == $id)')"
  [ -n "$t" ] || { fj_die "thread $tid が見つからない"; return 1; }
  code="$(fj_web POST "/$(fj_ensure_repo)/pulls/$(fj_pr_num)/files/reviews/comments" \
    --data-urlencode "origin=diff" \
    --data-urlencode "latest_commit_id=$(cat "$(fj_run_dir)/head")" \
    --data-urlencode "side=$(printf '%s' "$t" | jq -r '.side')" \
    --data-urlencode "line=$(printf '%s' "$t" | jq -r '.position')" \
    --data-urlencode "path=$(printf '%s' "$t" | jq -r '.path')" \
    --data-urlencode "reply=$(printf '%s' "$t" | jq -r '.review_id')" \
    --data-urlencode "content=$body")"
  case "$code" in
    2*) return 0 ;;
    *) fj_die "返信に失敗した (HTTP $code)"; return 1 ;;
  esac
}

fj_resolve() {
  local tid="$1" code
  code="$(fj_web POST "/$(fj_ensure_repo)/issues/resolve_conversation" \
    --data-urlencode "origin=diff" \
    --data-urlencode "action=Resolve" \
    --data-urlencode "comment_id=$tid")"
  case "$code" in
    2*) return 0 ;;
    *) fj_die "resolve に失敗した (HTTP $code)"; return 1 ;;
  esac
}

# 会話は (review_id, path, position) で決まる。先頭コメントの id を thread_id として
# 扱う。返信は review_id を、resolve は先頭コメント id を要求するので、どちらもここ
# から引ける。
#
# PENDING のレビューは投稿者にしか見えない下書きなので除外する。
fj_threads() {
  local repo pr rid stale
  repo="$(fj_ensure_repo)"
  pr="$(fj_pr_num)"
  fj_api GET "/repos/$repo/pulls/$pr/reviews" |
    jq -r '.[] | select(.state != "PENDING") | select(.comments_count > 0)
           | "\(.id)\t\(.stale)"' |
  while IFS=$'\t' read -r rid stale; do
    fj_api GET "/repos/$repo/pulls/$pr/reviews/$rid/comments" |
      jq --arg rid "$rid" --arg stale "$stale" '
        [ .[] | {rid: $rid, stale: ($stale == "true"), c: .} ]
        | group_by([.c.path, .c.position])
        | map(
            (. | sort_by(.c.id)) as $g
            | ($g[0]) as $first
            | ($g[-1]) as $last
            | {
                thread_id: $first.c.id,
                review_id: ($first.rid | tonumber),
                path: $first.c.path,
                position: $first.c.position,
                side: (if $first.c.position < 0 then "previous" else "proposed" end),
                commit_id: $first.c.commit_id,
                stale: $first.stale,
                resolved: ($first.c.resolver != null),
                resolver: ($first.c.resolver.login // null),
                awaiting_reply: (($first.c.resolver == null) and ($last.c.user.login == "reviewer")),
                html_url: $first.c.html_url,
                diff_hunk: $first.c.diff_hunk,
                comments: [ $g[] | {author: .c.user.login, created_at: .c.created_at, body: .c.body} ]
              }
          )'
  done | jq -s 'add // []'
}
