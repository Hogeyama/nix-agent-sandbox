// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://hogeyama.github.io",
  base: "/nix-agent-sandbox",
  integrations: [
    starlight({
      title: "nas",
      description:
        "AI コーディングエージェントを、ホストから隔離された Docker サンドボックスの中で動かすための CLI",
      defaultLocale: "root",
      locales: {
        root: { label: "日本語", lang: "ja" },
      },
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
      sidebar: [
        {
          label: "はじめに",
          items: [
            { label: "概要", link: "/intro/" },
            { label: "インストール", link: "/install/" },
            { label: "クイックスタート", link: "/quickstart/" },
          ],
        },
        {
          label: "機能ガイド",
          autogenerate: { directory: "guide" },
        },
        {
          label: "設定",
          items: [
            { label: "設定ファイル", link: "/config/file/" },
            { label: "設定パターン", link: "/config/patterns/" },
          ],
        },
        {
          label: "運用",
          items: [
            { label: "運用コマンド", link: "/operations/commands/" },
            { label: "セッション通知（フック）", link: "/operations/hooks/" },
            { label: "UI daemon", link: "/operations/ui/" },
          ],
        },
        {
          label: "セキュリティ",
          link: "/security/",
        },
        {
          label: "リファレンス",
          items: [
            { label: "制約・注意事項", link: "/reference/limitations/" },
            {
              label: "設定リファレンス (Schema.pkl)",
              link: "https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl",
              attrs: { target: "_blank" },
            },
          ],
        },
      ],
    }),
  ],
});
