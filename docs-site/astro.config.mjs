import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hogeyama.github.io",
  base: "/nix-agent-sandbox",
  integrations: [
    starlight({
      title: "nas",
      description: "AI コーディングエージェントを隔離して実行するためのユーザーガイド",
      locales: { root: { label: "日本語", lang: "ja" } },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Hogeyama/nix-agent-sandbox",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/Hogeyama/nix-agent-sandbox/edit/main/docs-site/",
      },
      lastUpdated: true,
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "はじめに",
          items: [
            { label: "nas とは", slug: "getting-started/about" },
            { label: "インストール", slug: "getting-started/installation" },
            { label: "クイックスタート", slug: "getting-started/quick-start" },
            { label: "設定の基本", slug: "getting-started/configuration" },
          ],
        },
        {
          label: "機能ガイド",
          items: [
            { label: "ファイル隔離・マウント", slug: "features/filesystem" },
            { label: "ネットワーク制御", slug: "features/network" },
            { label: "localhost ポート転送", slug: "features/port-forwarding" },
            { label: "HostExec", slug: "features/hostexec" },
            { label: "シークレット・認証情報", slug: "features/secrets" },
            { label: "Nix 統合", slug: "features/nix" },
            { label: "Docker in Docker", slug: "features/docker" },
            { label: "Worktree", slug: "features/worktree" },
            { label: "セッション・通知", slug: "features/sessions" },
            { label: "X11 / xpra", slug: "features/display" },
            { label: "UI daemon", slug: "features/ui" },
            { label: "Observability", slug: "features/observability" },
          ],
        },
        {
          label: "レシピ",
          items: [
            {
              label: ".env を隠してコマンドをホスト実行",
              slug: "recipes/mask-env",
            },
            {
              label: "相対パスコマンドを安全に移譲",
              slug: "recipes/relative-hostexec",
            },
            {
              label: "proxy 環境変数を参照しないツール",
              slug: "recipes/proxy-tools",
            },
            { label: "Codex の keyring", slug: "recipes/codex-keyring" },
            { label: "X11 アプリを表示する", slug: "recipes/x11-apps" },
          ],
        },
        {
          label: "運用",
          items: [
            {
              label: "Docker イメージを再ビルドする",
              slug: "operations/maintenance",
            },
            {
              label: "承認キューを操作する",
              slug: "operations/approvals",
            },
            { label: "監査ログを確認する", slug: "operations/audit" },
          ],
        },
        {
          label: "セキュリティ",
          items: [
            {
              label: "設計思想と信頼境界",
              slug: "security/model",
            },
            { label: "機能別リスク", slug: "security/risks" },
            { label: "推奨設定", slug: "security/recommendations" },
            { label: "制約・注意事項", slug: "security/limitations" },
          ],
        },
      ],
    }),
  ],
});
