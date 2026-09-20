/**
 * 仕様「記述例」の 3 つの設定を TS に写したもの。テストからのみ使う。
 *
 * 設計ドキュメントが受け入れ条件として掲げている設定なので、書き換えるときは
 * 仕様の側と突き合わせること。値は仕様の Pkl をそのまま写している。
 */

import addonDocument from "../fixtures/authz/resolved-document.json";
import type { AuthzConfig, Expect } from "./config.ts";
import type { GraphqlMatch } from "./types.ts";

/**
 * 仕様「設定管理者が書くもの」の GraphQL 条件。
 *
 * `match.body.graphql` にも `BodyExpect.graphql` にも同じ形で置けるので、
 * 期待表 ({@link GRAPHQL_TABLE_CASES}) は両側でこの 1 本を使い回す。
 */
export const SPEC_GRAPHQL_CONDITION: GraphqlMatch = {
  operations: ["query"],
  fieldPaths: [
    "/repository/nameWithOwner",
    "/repository/issues/nodes/body",
    "/repository/issues/nodes/comments/nodes/body",
    "/repository/issues/pageInfo/endCursor",
    "/repository/issues/pageInfo/hasNextPage",
    "/repository/object/text",
    "/organization/login",
    "/organization/membersWithRole/nodes/login",
  ],
  fieldArguments: {
    "/repository": { owner: ["my-org"] },
    "/organization": { login: ["my-org"] },
  },
};

/** 要件 1: GraphQL の読み取りだけ自動許可する。 */
export function githubGraphqlExample(): AuthzConfig {
  return {
    secrets: { "gh-token": { from: "cmd:gh auth token" } },
    network: {
      scopes: {
        github: {
          targets: ["api.github.com"],
          fallback: "review",
          secrets: { "gh-token": "inject" },
          inject: [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: template: の ${...} は Pkl の設定値の構文であり、TS のテンプレートリテラルではない
            { name: "Authorization", value: "template:Bearer ${gh-token}" },
          ],
          rules: {
            graphql: {
              match: {
                methods: ["POST"],
                paths: ["/graphql"],
                body: { format: "json" },
              },
              onMatch: "allow",
              onIndeterminate: "review",
              expect: [
                {
                  kind: "body",
                  graphql: SPEC_GRAPHQL_CONDITION,
                  onViolation: "review",
                },
              ],
            },
          },
        },
      },
    },
  };
}

/**
 * 仕様冒頭の反例をそのまま写した document。
 *
 * 信頼する organization を入口にしても、メンバーの star を辿れば第三者の
 * リポジトリの Issue 本文・コメント本文・README 本文まで出られる、という
 * 一本の query である。`githubGraphqlExample` の許可経路を当てると、
 * 禁止末端がちょうど {@link STARRED_CROSSING_REFUSED_LEAVES} の 3 本になる。
 *
 * **短縮しないこと。** 末端を 1 本だけ残した縮小版でも「反例が review に
 * なる」テストは緑になるが、それは「メンバー経路を丸ごと禁止したから」でも
 * 通ってしまう。Issue 本文 (`issues/nodes/body`)、コメント本文
 * (`comments/nodes/body`)、README 本文 (`object/text`) が**すべて**別々に
 * 検出されることが、経路ごとの検査が働いている証拠になる。
 * `githubGraphqlExample` が `/organization/membersWithRole/nodes/login` を
 * 許しているのも同じ理由で、メンバー経路そのものは通れる状態で star から先を
 * 止めていることを見せるためである。
 */
export const STARRED_CROSSING_QUERY = `query {
  organization(login: "my-org") {
    membersWithRole(first: 10) {
      nodes {
        starredRepositories(first: 10) {
          nodes {
            issues(first: 10) {
              nodes { body comments(first: 10) { nodes { body } } }
            }
            object(expression: "HEAD:README.md") { ... on Blob { text } }
          }
        }
      }
    }
  }
}`;

/** {@link STARRED_CROSSING_QUERY} が踏む禁止末端。document 順。 */
export const STARRED_CROSSING_REFUSED_LEAVES: readonly string[] = [
  "/organization/membersWithRole/nodes/starredRepositories/nodes/issues/nodes/body",
  "/organization/membersWithRole/nodes/starredRepositories/nodes/issues/nodes/comments/nodes/body",
  "/organization/membersWithRole/nodes/starredRepositories/nodes/object/text",
];

/**
 * 期待表の全ケースに当てる解析予算。
 *
 * `match` に置いた条件と `expect` に置いた条件で**同じ値**を使う。片方だけ
 * 既定の天井のままにすると、予算超過の行が「match では判定不能、expect では
 * 違反なし」のように割れ、その食い違いが実装の穴ではなく設定の差から来る。
 * 許可ケースと反例が収まり、{@link GRAPHQL_TABLE_CASES} の `over-node-budget` /
 * `over-expansion-budget` / `over-depth-budget` だけが越える大きさにしてある。
 */
export const GRAPHQL_TABLE_LIMITS = { maxNodes: 400, maxDepth: 16 } as const;

/** {@link GraphqlTableCase} の `match` 側の真理値。 */
export type GraphqlTruth = "true" | "false" | "indeterminate";

/** 期待する違反レコードの種別と表示名。値は毎回変わる UUID なので持たない。 */
export interface GraphqlTableViolation {
  readonly kind: "schema-mismatch" | "body-unavailable";
  readonly label: string;
}

/**
 * 1 つの document を `match` と `expect` の両側に通したときの期待。
 *
 * `matchTruth` が `"true"` であることと `violations` が空であることは同値で
 * なければならない。addon は真理値 (`_graphql_selection_satisfies`) と違反の
 * 列挙 (`_graphql_selection_violations`) を別々に書いているので、この同値が
 * 崩れると「真理値は偽なのに違反が 1 件も出ず、expect が黙って通る」という
 * fail-open になる。表を 1 本にしてあるのはその同値を機械的に確かめるため。
 */
export interface GraphqlTableCase {
  readonly name: string;
  /** JSON にする値。`path` を持つ行は URL のクエリ文字列も付ける。 */
  readonly body: unknown;
  readonly path?: string;
  readonly matchTruth: GraphqlTruth;
  /** `expect` 側に出る違反。`kind`・`label`・順序まで固定する。 */
  readonly violations: readonly GraphqlTableViolation[];
}

function path(label: string): GraphqlTableViolation {
  return { kind: "schema-mismatch", label: `fieldPath:${label}` };
}

function argument(label: string): GraphqlTableViolation {
  return { kind: "schema-mismatch", label: `fieldArgument:${label}` };
}

function operation(kind: string): GraphqlTableViolation {
  return { kind: "schema-mismatch", label: `operation:${kind}` };
}

const UNANALYSABLE: GraphqlTableViolation = {
  kind: "body-unavailable",
  label: "document:(unanalysable)",
};

/**
 * token 数は小さいが、fragment の展開量が {@link GRAPHQL_TABLE_LIMITS} の
 * `maxNodes` を越える document。各 fragment が次を 2 回 spread するので、
 * 使用位置での展開は 2 のべき乗で増える。
 */
const DIAMOND_FRAGMENTS = [
  'query { repository(owner: "my-org", name: "x") { ...f0 } }',
  ...Array.from(
    { length: 8 },
    (_, index) =>
      `fragment f${index} on Repository { ...f${index + 1} ...f${index + 1} }`,
  ),
  "fragment f8 on Repository { nameWithOwner }",
].join(" ");

/** 禁止末端を 1 本だけ踏む query。行 6 の変形はすべてこれと同じ答えになる。 */
const REFUSED_FORK_LEAF =
  'query { repository(owner: "my-org", name: "x") { forks(first: 1) { nodes { nameWithOwner } } } }';

/** 行 6 の変形群。`base` と同じ答えになることを要求する。 */
export const REFUSED_FORK_DISGUISES: readonly string[] = [
  "refused-fork-alias",
  "refused-fork-named-fragment",
  "refused-fork-inline-fragment",
  "refused-fork-skip",
  "refused-fork-include",
];

/**
 * 仕様の期待表 (実装計画 Task 4 の表) をそのまま並べたケース集。
 *
 * ここに置いてあるのは**入力と期待だけ**で、条件をどちらに置くかは使う側が
 * 決める。`graphql_acceptance_test.ts` は同じ条件を `match` に置いた設定と
 * `expect` に置いた設定の 2 本に通し、`decide_parity_test.ts` は同じ document・
 * 同じ variables・同じ limits で TS と Python の選択を突き合わせる。
 * 期待をこの 1 箇所に置いているので、片方だけ緩めることができない。
 */
export const GRAPHQL_TABLE_CASES: readonly GraphqlTableCase[] = [
  // 行 1: 許可した Issue 本文・コメント本文・README 本文だけを読む。
  {
    name: "allowed-issue-and-readme",
    body: {
      query:
        'query($o: String!) { repository(owner: $o, name: "x") {' +
        " nameWithOwner" +
        " issues(first: 10) { nodes { body comments(first: 10) { nodes { body } } }" +
        " pageInfo { endCursor hasNextPage } }" +
        ' object(expression: "HEAD:README.md") { ... on Blob { text } } } }',
      variables: { o: "my-org" },
    },
    matchTruth: "true",
    violations: [],
  },
  {
    // メンバーの login までは許可経路である。反例が偽になるのは「メンバー
    // 経路を丸ごと禁止したから」ではないことを、この行が示す。
    name: "allowed-organization-members",
    body: {
      query:
        'query { organization(login: "my-org") { login' +
        " membersWithRole(first: 10) { nodes { login } } } }",
    },
    matchTruth: "true",
    violations: [],
  },

  // 行 2: spec 冒頭の反例。3 本の禁止末端が別々に検出される。
  {
    name: "starred-crossing",
    body: { query: STARRED_CROSSING_QUERY },
    matchTruth: "false",
    violations: STARRED_CROSSING_REFUSED_LEAVES.map(path),
  },

  // 行 3: owner の欠落と許可外。
  {
    name: "owner-missing",
    body: { query: '{ repository(name: "x") { nameWithOwner } }' },
    matchTruth: "false",
    violations: [argument("/repository@owner=(missing)")],
  },
  {
    name: "owner-not-allowed",
    body: {
      query:
        'query($o: String!) { repository(owner: $o, name: "x") { nameWithOwner } }',
      variables: { o: "other-org" },
    },
    matchTruth: "false",
    violations: [argument("/repository@owner=(not-allowed)")],
  },
  {
    // 別の field に許可された owner があっても、`/repository` の要求は満たさない。
    name: "owner-borrowed-from-another-field",
    body: {
      query:
        'query { organization(login: "my-org") { login }' +
        ' repository(name: "x") { nameWithOwner } }',
    },
    matchTruth: "false",
    violations: [argument("/repository@owner=(missing)")],
  },

  // 行 4: owner が明示 null、または解決できない変数。
  {
    name: "owner-explicit-null",
    body: {
      query:
        'query($o: String = "my-org") { repository(owner: $o, name: "x") { nameWithOwner } }',
      variables: { o: null },
    },
    matchTruth: "indeterminate",
    violations: [argument("/repository@owner=(unresolved)")],
  },
  {
    name: "owner-unresolved-variable",
    body: {
      query:
        'query($o: String!) { repository(owner: $o, name: "x") { nameWithOwner } }',
    },
    matchTruth: "indeterminate",
    violations: [argument("/repository@owner=(unresolved)")],
  },

  // 行 5: 未知 directive と展開予算超過。どちらも document ごと解析不能。
  {
    name: "unknown-directive",
    body: {
      query:
        'query { repository(owner: "my-org", name: "x") @cache(ttl: 10) { nameWithOwner } }',
    },
    matchTruth: "indeterminate",
    violations: [UNANALYSABLE],
  },
  {
    // token 数で `maxNodes` を越える。読み切れない document を偽に倒すと、
    // 長い document を送るだけでより広いルールへ落とせてしまう。
    name: "over-node-budget",
    body: {
      query: `query { repository(owner: "my-org", name: "x") { ${Array.from(
        { length: 500 },
        (_, index) => `f${index}`,
      ).join(" ")} } }`,
    },
    matchTruth: "indeterminate",
    violations: [UNANALYSABLE],
  },
  {
    // token 数は予算内だが、fragment のダイヤモンド展開が `maxNodes` を越える。
    // 展開を途中で止めて「見た範囲では違反なし」とする実装はここで割れる。
    name: "over-expansion-budget",
    body: { query: DIAMOND_FRAGMENTS },
    matchTruth: "indeterminate",
    violations: [UNANALYSABLE],
  },
  {
    name: "over-depth-budget",
    body: {
      query: `query { repository(owner: "my-org", name: "x") { ${"a { ".repeat(
        20,
      )}b${" }".repeat(20)} } }`,
    },
    matchTruth: "indeterminate",
    violations: [UNANALYSABLE],
  },

  // 行 6: 禁止 field を alias・fragment・skip/include で隠しても答えは変わらない。
  {
    name: "refused-fork-base",
    body: { query: REFUSED_FORK_LEAF },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },
  {
    name: "refused-fork-alias",
    body: {
      query:
        'query { repository(owner: "my-org", name: "x") {' +
        " issues: forks(first: 1) { nodes { nameWithOwner } } } }",
    },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },
  {
    name: "refused-fork-named-fragment",
    body: {
      query:
        'query { repository(owner: "my-org", name: "x") { ...f } }' +
        " fragment f on Repository { forks(first: 1) { nodes { nameWithOwner } } }",
    },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },
  {
    name: "refused-fork-inline-fragment",
    body: {
      query:
        'query { repository(owner: "my-org", name: "x") { ... on Repository {' +
        " forks(first: 1) { nodes { nameWithOwner } } } } }",
    },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },
  {
    name: "refused-fork-skip",
    body: {
      query:
        'query { repository(owner: "my-org", name: "x") {' +
        " forks(first: 1) @skip(if: true) { nodes { nameWithOwner } } } }",
    },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },
  {
    name: "refused-fork-include",
    body: {
      query:
        'query { repository(owner: "my-org", name: "x") {' +
        " forks(first: 1) @include(if: false) { nodes { nameWithOwner } } } }",
    },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },

  // 行 7: 安全な operation と不安全な operation の同居。
  {
    name: "safe-and-unsafe-queries",
    body: {
      query:
        'query Safe { repository(owner: "my-org", name: "x") { nameWithOwner } }' +
        ' query Unsafe { repository(owner: "my-org", name: "x") {' +
        " forks(first: 1) { nodes { nameWithOwner } } } }",
    },
    matchTruth: "false",
    violations: [path("/repository/forks/nodes/nameWithOwner")],
  },
  {
    // 不安全な operation が 2 本。片方で打ち切らず、全 operation を検査する。
    name: "two-unsafe-queries",
    body: {
      query:
        'query A { repository(owner: "my-org", name: "x") {' +
        " forks(first: 1) { nodes { nameWithOwner } } } }" +
        ' query B { repository(owner: "my-org", name: "x") {' +
        " watchers(first: 1) { nodes { login } } } }",
    },
    matchTruth: "false",
    violations: [
      path("/repository/forks/nodes/nameWithOwner"),
      path("/repository/watchers/nodes/login"),
    ],
  },
  {
    name: "safe-query-and-mutation",
    body: {
      query:
        'query Safe { repository(owner: "my-org", name: "x") { nameWithOwner } }' +
        ' mutation Unsafe { addStar(input: { starrableId: "x" }) { clientMutationId } }',
    },
    matchTruth: "false",
    violations: [operation("mutation"), path("/addStar/clientMutationId")],
  },
  {
    // 偽の operation と判定不能の operation が同居したら判定不能を優先する。
    // expect 側は両方の違反を出す。
    name: "false-and-indeterminate-queries",
    body: {
      query:
        'query A { repository(owner: "my-org", name: "x") {' +
        " forks(first: 1) { nodes { nameWithOwner } } } }" +
        ' query B($o: String!) { repository(owner: $o, name: "x") { nameWithOwner } }',
    },
    matchTruth: "indeterminate",
    violations: [
      path("/repository/forks/nodes/nameWithOwner"),
      argument("/repository@owner=(unresolved)"),
    ],
  },
];

// ---------------------------------------------------------------------------
// このリポジトリ自身の `.nas/config.pkl` (仕様「導入範囲と旧形式の廃止」の表)
// ---------------------------------------------------------------------------

/** `.nas/config.pkl` の `githubOwners`。GitHub の login は大小を区別しない。 */
export const REPO_GITHUB_OWNERS: readonly string[] = ["Hogeyama", "hogeyama"];

/**
 * `.nas/config.pkl` の `github-api` スコープの GraphQL 条件。
 *
 * 仕様「導入範囲と旧形式の廃止」の初期許可表を、各 root の下の完全経路へ
 * 展開したものである。`repo_pkl_test.ts` が実際の `.nas/config.pkl` を pkl で
 * 評価して解決済み JSON をこの値と突き合わせるので、設定とこの定数が離れたら
 * どちらかのテストが落ちる。便宜的な末端をここに足してはならない。足すときは
 * 仕様の表も同時に直す。
 */
export const REPO_GRAPHQL_CONDITION: GraphqlMatch = {
  operations: ["query"],
  fieldPaths: [
    "/repository/nameWithOwner",
    "/repository/url",
    "/repository/issues/nodes/number",
    "/repository/issues/nodes/title",
    "/repository/issues/nodes/body",
    "/repository/issues/nodes/comments/nodes/body",
    "/repository/issues/pageInfo/endCursor",
    "/repository/issues/pageInfo/hasNextPage",
    "/repository/pullRequests/nodes/number",
    "/repository/pullRequests/nodes/title",
    "/repository/pullRequests/nodes/body",
    "/repository/pullRequests/nodes/comments/nodes/body",
    "/repository/pullRequests/pageInfo/endCursor",
    "/repository/pullRequests/pageInfo/hasNextPage",
    "/repository/object/text",
    "/organization/login",
    "/user/login",
    "/repositoryOwner/login",
  ],
  fieldArguments: {
    "/repository": { owner: REPO_GITHUB_OWNERS },
    "/organization": { login: REPO_GITHUB_OWNERS },
    "/user": { login: REPO_GITHUB_OWNERS },
    "/repositoryOwner": { login: REPO_GITHUB_OWNERS },
  },
};

/**
 * 仕様冒頭の反例を、信頼する owner を入口にして書き直したもの。
 *
 * 入口の `organization(login:)` は `.nas/config.pkl` の必須引数を満たす。
 * それでもメンバーの star から先は許可経路ではないので、踏む禁止末端は
 * {@link STARRED_CROSSING_REFUSED_LEAVES} と同じ 3 本になる。
 * 「入口が自分の所有物なら通る」わけではないことを示すために owner を
 * 差し替えてある (許可外の owner にすると引数違反が混ざって、経路の側が
 * 効いているかどうかが見えなくなる)。
 */
export const REPO_STARRED_CROSSING_QUERY = STARRED_CROSSING_QUERY.replace(
  '"my-org"',
  '"Hogeyama"',
);

/**
 * `.nas/config.pkl` の条件に対する A19 の期待 (受け入れ条件「通常4プロファイル
 * で自 owner の許可経路、他 owner、反例」)。
 *
 * {@link GRAPHQL_TABLE_CASES} と同じ形なので、`graphql_acceptance_test.ts` が
 * 同じ検査 (真理値と違反の同値、UUID、`excerpt === null`) を当てられる。
 */
export const REPO_GRAPHQL_CASES: readonly GraphqlTableCase[] = [
  {
    // 自 owner の Issue: 番号・題・本文・コメント本文・ページング。
    name: "repo-allowed-issues",
    body: {
      query:
        'query($o: String!) { repository(owner: $o, name: "nix-agent-sandbox") {' +
        " nameWithOwner url" +
        " issues(first: 10) { nodes { number title body" +
        " comments(first: 10) { nodes { body } } }" +
        " pageInfo { endCursor hasNextPage } } } }",
      variables: { o: "Hogeyama" },
    },
    matchTruth: "true",
    violations: [],
  },
  {
    // 同じ形の PullRequest 側と、URL 表記の小文字 owner。
    name: "repo-allowed-pull-requests",
    body: {
      query:
        'query { repository(owner: "hogeyama", name: "nix-agent-sandbox") {' +
        " pullRequests(first: 10) { nodes { number title body" +
        " comments(first: 10) { nodes { body } } }" +
        " pageInfo { endCursor hasNextPage } } } }",
    },
    matchTruth: "true",
    violations: [],
  },
  {
    // README 本文。型条件は経路要素にならない。
    name: "repo-allowed-readme",
    body: {
      query:
        'query { repository(owner: "Hogeyama", name: "nix-agent-sandbox") {' +
        ' object(expression: "HEAD:README.md") { ... on Blob { text } } } }',
    },
    matchTruth: "true",
    violations: [],
  },
  {
    // 所有者の確認だけを行う 3 つの root。
    name: "repo-allowed-owner-logins",
    body: {
      query:
        'query { organization(login: "Hogeyama") { login }' +
        ' user(login: "hogeyama") { login }' +
        ' repositoryOwner(login: "Hogeyama") { login } }',
    },
    matchTruth: "true",
    violations: [],
  },
  {
    // 他 owner。経路は許可されているが引数が許可集合の外。
    name: "repo-other-owner",
    body: {
      query:
        'query { repository(owner: "other-org", name: "x") { nameWithOwner } }',
    },
    matchTruth: "false",
    violations: [argument("/repository@owner=(not-allowed)")],
  },
  {
    // user → star。自分の login を入口にしても star の先は許可経路ではない。
    name: "repo-user-starred",
    body: {
      query:
        'query { user(login: "Hogeyama") { login' +
        " starredRepositories(first: 10) { nodes { nameWithOwner } } } }",
    },
    matchTruth: "false",
    violations: [path("/user/starredRepositories/nodes/nameWithOwner")],
  },
  {
    // member → star → Issue/README。仕様冒頭の反例。
    name: "repo-organization-member-starred",
    body: { query: REPO_STARRED_CROSSING_QUERY },
    matchTruth: "false",
    violations: STARRED_CROSSING_REFUSED_LEAVES.map(path),
  },
  {
    name: "repo-mutation",
    body: {
      query:
        'mutation { addStar(input: { starrableId: "x" }) { clientMutationId } }',
    },
    matchTruth: "false",
    violations: [operation("mutation"), path("/addStar/clientMutationId")],
  },
  {
    // 未許可の metadata field。許可した兄弟と同じ親の下でも自動許可しない。
    name: "repo-unlisted-metadata",
    body: {
      query:
        'query { repository(owner: "Hogeyama", name: "nix-agent-sandbox") {' +
        " nameWithOwner description sshUrl } }",
    },
    matchTruth: "false",
    violations: [path("/repository/description"), path("/repository/sshUrl")],
  },
];

/**
 * `.nas/config.pkl` の `github-api` スコープを TS に写したもの。
 *
 * GraphQL の条件だけでなく REST の読み取りルール (`owned.rest-read` の
 * `methods` / `paths` / `captures`) とスコープの `fallback` も手で写して
 * いる。A19 が要求するのは「GraphQL を経路で絞っても REST の境界が動いて
 * いないこと」なので、同じドキュメントの上で両方を見る必要がある。
 *
 * `REPO_GRAPHQL_CONDITION` と同様、この REST ルールとスコープ `fallback` も
 * `repo_pkl_test.ts` が実際の `.nas/config.pkl` を pkl で評価した値と
 * 突き合わせる。ここを書き換えても実ファイルと突き合わせるテストが無ければ
 * 食い違いに気付けないので、書き換えるときは `repo_pkl_test.ts` 側も見る
 * こと。
 */
export function repoGithubApiExample(): AuthzConfig {
  return {
    secrets: { "gh-token-basic": { from: "cmd:gh auth token" } },
    network: {
      fallback: "review",
      scopes: {
        "github-api": {
          targets: ["api.github.com:443"],
          fallback: "review",
          secrets: { "gh-token-basic": "inject" },
          inject: [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: template: の ${...} は Pkl の設定値の構文であり、TS のテンプレートリテラルではない
            { name: "Authorization", value: "template:${gh-token-basic}" },
          ],
          rules: {
            "owned.rest-read": {
              match: {
                methods: ["GET", "HEAD"],
                paths: [
                  "/repos/{owner}/**",
                  "/users/{owner}/**",
                  "/orgs/{owner}/**",
                ],
                captures: { owner: REPO_GITHUB_OWNERS },
              },
              onMatch: "allow",
            },
            "graphql.read": {
              match: {
                methods: ["POST"],
                paths: ["/graphql"],
                body: { format: "json" },
              },
              onMatch: "allow",
              onIndeterminate: "review",
              expect: [
                {
                  kind: "body",
                  graphql: REPO_GRAPHQL_CONDITION,
                  onViolation: "review",
                },
              ],
            },
          },
        },
      },
    },
  };
}

/** 要件 2 と 3: パスのセグメントで絞り、同じ条件で注入する。 */
export function githubPathsExample(): AuthzConfig {
  return {
    secrets: { "gh-token": { from: "cmd:gh auth token" } },
    network: {
      fallback: "review",
      scopes: {
        github: {
          targets: ["api.github.com"],
          fallback: "review",
          secrets: { "gh-token": "inject" },
          inject: [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: template: の ${...} は Pkl の設定値の構文であり、TS のテンプレートリテラルではない
            { name: "Authorization", value: "template:Bearer ${gh-token}" },
          ],
          rules: {
            "repos.read": {
              match: {
                methods: ["GET", "HEAD"],
                paths: ["/repos/{org}/{repo}/**"],
                captures: { org: ["my-org"] },
              },
              onMatch: "allow",
            },
            "issues.write": {
              match: {
                methods: ["POST", "PATCH"],
                paths: [
                  "/repos/{org}/{repo}/issues",
                  "/repos/{org}/{repo}/issues/*",
                ],
                captures: { org: ["my-org"] },
              },
              onMatch: "allow",
            },
            "repos.delete": {
              match: { methods: ["DELETE"], paths: ["/repos/**"] },
              onMatch: "review",
            },
          },
        },
      },
    },
  };
}

/** 許容タグは addon テスト用の解決済みドキュメントから引く。 */
const contentGuard = addonDocument.scopes
  .flatMap((scope) => scope.rules)
  .find((rule) => rule.id === "anthropic.messages")
  ?.expect.find(
    (condition) =>
      condition.kind === "unionShape" &&
      "at" in condition &&
      condition.at === "/**/content/*",
  );
if (
  !contentGuard ||
  !("allowed" in contentGuard) ||
  !Array.isArray(contentGuard.allowed) ||
  !contentGuard.allowed.every((tag): tag is string => typeof tag === "string")
) {
  throw new Error("Anthropic fixture is missing its content-block tag guard");
}
const CONTENT_TAGS: readonly string[] = contentGuard.allowed;

const CONTENT_BLOCKS: readonly Expect[] = [
  {
    kind: "unionShape",
    at: "/**/content/*",
    exclude: ["/tools/**"],
    discriminator: "type",
    allowed: CONTENT_TAGS,
    onViolation: "review",
  },
  {
    kind: "unionShape",
    at: "/system/*",
    discriminator: "type",
    allowed: CONTENT_TAGS,
    onViolation: "review",
  },
  { kind: "jsonRoot", rootType: "object" },
];

/** 要件 4 から 6: Anthropic preset の新しい形。 */
export function anthropicExample(): AuthzConfig {
  return {
    network: {
      scopes: {
        anthropic: {
          targets: ["api.anthropic.com"],
          fallback: "deny",
          rules: {
            messages: {
              match: {
                methods: ["POST"],
                paths: ["/v1/messages", "/v1/messages/count_tokens"],
                body: { format: "json" },
              },
              onMatch: "allow",
              onIndeterminate: "deny",
              expect: CONTENT_BLOCKS,
            },
            bootstrap: {
              match: {
                methods: ["GET"],
                paths: [
                  "/api/claude_cli/bootstrap",
                  "/api/claude_code_penguin_mode",
                  "/api/claude_code/policy_limits",
                  "/api/claude_code/settings",
                  "/mcp-registry/v0/servers",
                  "/v1/code/triggers",
                  "/v1/mcp_servers",
                ],
              },
              onMatch: "allow",
              expect: [{ kind: "emptyBody" }],
            },
          },
        },
      },
    },
  };
}
