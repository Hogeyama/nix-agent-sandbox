/**
 * 仕様「記述例」の 3 つの設定を TS に写したもの。テストからのみ使う。
 *
 * 設計ドキュメントが受け入れ条件として掲げている設定なので、書き換えるときは
 * 仕様の側と突き合わせること。値は仕様の Pkl をそのまま写している。
 */

import type { AuthzConfig, Expect } from "./config.ts";

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
                  graphql: { operations: ["query"] },
                  equals: { "/variables/o": "my-org" },
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

/** `anthropic@1` が許可する content block のタグ集合。 */
const CONTENT_TAGS: readonly string[] = [
  "text",
  "image",
  "document",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "server_tool_use",
  "web_search_tool_result",
  "code_execution_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
  "search_result",
  "container_upload",
];

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
