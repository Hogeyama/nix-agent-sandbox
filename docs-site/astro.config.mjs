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
            { label: "インストール", slug: "getting-started/installation" },
            { label: "クイックスタート", slug: "getting-started/quick-start" },
            { label: "設定の基本", slug: "getting-started/configuration" },
          ],
        },
        {
          label: "機能別の設定",
          items: [
            { label: "ファイル隔離・マウント", slug: "features/filesystem" },
            { label: "ネットワーク制御", slug: "features/network" },
            { label: "localhost ポート転送", slug: "features/port-forwarding" },
            { label: "コンテナポート公開", slug: "features/port-bind" },
            { label: "HostExec", slug: "features/hostexec" },
            { label: "シークレット・認証情報", slug: "features/secrets" },
            { label: "Nix 統合", slug: "features/nix" },
            { label: "Docker in Docker", slug: "features/docker" },
            { label: "Worktree", slug: "features/worktree" },
            { label: "セッション・通知", slug: "features/sessions" },
            { label: "X11 / xpra", slug: "features/display" },
            { label: "ブラウザ UI", slug: "features/ui" },
            { label: "実行履歴・利用量", slug: "features/observability" },
          ],
        },
        {
          label: "運用",
          items: [
            {
              label: "イメージ・作業環境の管理",
              slug: "operations/maintenance",
            },
            {
              label: "通信・ホスト実行の承認",
              slug: "operations/approvals",
            },
            { label: "監査ログ", slug: "operations/audit" },
          ],
        },
        {
          label: "設定例",
          items: [
            {
              label: ".env の非公開とホスト実行",
              slug: "recipes/mask-env",
            },
            {
              label: "相対パスコマンドのホスト実行",
              slug: "recipes/relative-hostexec",
            },
            {
              label: "Gradle・Maven のプロキシ設定",
              slug: "recipes/proxy-tools",
            },
            { label: "Codex のキーリング", slug: "recipes/codex-keyring" },
            { label: "X11 アプリの表示", slug: "recipes/x11-apps" },
          ],
        },
        {
          label: "セキュリティ",
          items: [
            {
              label: "隔離の範囲",
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
