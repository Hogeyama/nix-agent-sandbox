import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hogeyama.github.io",
  base: "/nix-agent-sandbox",
  redirects: {
    "/getting-started/configuration/":
      "/nix-agent-sandbox/configuration/profiles/",
    "/features/ui/": "/nix-agent-sandbox/work/sessions/",
    "/features/sessions/": "/nix-agent-sandbox/work/sessions/",
    "/features/worktree/": "/nix-agent-sandbox/work/sessions/",
    "/operations/approvals/": "/nix-agent-sandbox/work/approvals/",
    "/features/port-bind/": "/nix-agent-sandbox/work/preview/",
    "/operations/audit/": "/nix-agent-sandbox/work/troubleshooting/",
    "/features/observability/": "/nix-agent-sandbox/work/history/",
    "/operations/maintenance/": "/nix-agent-sandbox/work/finish/",
    "/features/filesystem/": "/nix-agent-sandbox/configuration/files/",
    "/recipes/mask-env/":
      "/nix-agent-sandbox/configuration/host-commands/#秘密値付きのビルド",
    "/features/network/": "/nix-agent-sandbox/configuration/network/",
    "/recipes/proxy-tools/":
      "/nix-agent-sandbox/configuration/network/#ツール側のプロキシ設定",
    "/features/port-forwarding/":
      "/nix-agent-sandbox/configuration/host-services/",
    "/features/hostexec/": "/nix-agent-sandbox/configuration/host-commands/",
    "/recipes/relative-hostexec/":
      "/nix-agent-sandbox/configuration/host-commands/#相対パスのコマンド",
    "/features/secrets/": "/nix-agent-sandbox/configuration/authentication/",
    "/recipes/codex-keyring/":
      "/nix-agent-sandbox/configuration/authentication/#codex-のキーリング",
    "/features/nix/":
      "/nix-agent-sandbox/configuration/development/#nix-の共有",
    "/features/docker/":
      "/nix-agent-sandbox/configuration/development/#テスト用-docker",
    "/features/display/": "/nix-agent-sandbox/configuration/gui/",
    "/recipes/x11-apps/": "/nix-agent-sandbox/configuration/gui/",
    "/security/model/": "/nix-agent-sandbox/security/isolation/",
    "/security/risks/": "/nix-agent-sandbox/security/isolation/",
    "/security/recommendations/": "/nix-agent-sandbox/security/isolation/",
    "/security/limitations/": "/nix-agent-sandbox/security/isolation/",
  },
  integrations: [
    starlight({
      title: "nas",
      description:
        "AI コーディングエージェントを隔離して実行するためのユーザーガイド",
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
            {
              label: "インストール",
              slug: "getting-started/installation",
            },
            {
              label: "最初の作業",
              slug: "getting-started/quick-start",
            },
          ],
        },
        {
          label: "作業中の操作",
          items: [
            {
              label: "作業の開始・再開",
              slug: "work/sessions",
            },
            {
              label: "通信・ホスト実行の承認",
              slug: "work/approvals",
            },
            {
              label: "開発サーバーの確認",
              slug: "work/preview",
            },
            {
              label: "作業中の問題と調査",
              slug: "work/troubleshooting",
            },
            {
              label: "過去の作業と利用量",
              slug: "work/history",
            },
            {
              label: "作業の終了と片付け",
              slug: "work/finish",
            },
          ],
        },
        {
          label: "作業環境の設定",
          items: [
            {
              label: "設定の変更と反映",
              slug: "configuration/profiles",
            },
            {
              label: "外部への通信許可",
              slug: "configuration/network",
            },
            {
              label: "ファイルの共有と非公開",
              slug: "configuration/files",
            },
            {
              label: "ホストコマンドの実行許可",
              slug: "configuration/host-commands",
            },
            {
              label: "ホストの DB・API への接続",
              slug: "configuration/host-services",
            },
            {
              label: "ホストの認証情報の利用",
              slug: "configuration/authentication",
            },
            {
              label: "開発ツールと Docker",
              slug: "configuration/development",
            },
            {
              label: "GUI アプリの表示",
              slug: "configuration/gui",
            },
            {
              label: "入力待ちの通知",
              slug: "configuration/notifications",
            },
            {
              label: "記録と保存期間",
              slug: "configuration/recording",
            },
          ],
        },
        {
          label: "隔離の前提",
          items: [
            {
              label: "隔離の範囲",
              slug: "security/isolation",
            },
          ],
        },
      ],
    }),
  ],
});
