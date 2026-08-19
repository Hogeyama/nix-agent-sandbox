import { describe, expect, test } from "bun:test";
import type { Inject } from "../config/types.ts";
import { describeInjectHeaders, renderInjectHeaders } from "./secrets.ts";

const REGISTRY = {
  "gh-token": ["ghp_realtokenvalue"],
  "extra-token": ["extra_realtokenvalue"],
  "many-valued": ["one", "two"],
};

describe("describeInjectHeaders", () => {
  test("ヘッダー名と参照する秘密の名前だけを返す", () => {
    const injects: Inject[] = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
      { name: "Authorization", value: "template:Bearer ${gh-token}" },
      { name: "X-Token", value: "secret:extra-token" },
    ];
    expect(describeInjectHeaders(injects, REGISTRY)).toEqual([
      { name: "Authorization", secrets: ["gh-token"] },
      { name: "X-Token", secrets: ["extra-token"] },
    ]);
  });

  test("秘密の値も template の地の文も現れない", () => {
    const injects: Inject[] = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
      { name: "Authorization", value: "template:Bearer ${gh-token}" },
      { name: "X-Plain", value: "literal:not-a-secret-but-still-a-value" },
    ];
    const shown = JSON.stringify(describeInjectHeaders(injects, REGISTRY));
    expect(shown).not.toContain("ghp_realtokenvalue");
    expect(shown).not.toContain("Bearer");
    expect(shown).not.toContain("not-a-secret-but-still-a-value");
  });

  test("秘密を参照しない注入は空の一覧を持つ", () => {
    const injects: Inject[] = [{ name: "X-Plain", value: "literal:plain" }];
    expect(describeInjectHeaders(injects, REGISTRY)).toEqual([
      { name: "X-Plain", secrets: [] },
    ]);
  });

  test("実際には送られない注入は出さない", () => {
    // 画面に出たものと送出されるものが食い違ってはならないので、
    // renderInjectHeaders が落とすエントリはここでも落ちる。
    const injects: Inject[] = [
      { name: "X-Missing", value: "secret:not-in-registry" },
      { name: "X-Ambiguous", value: "secret:many-valued" },
      { name: "X-Malformed", value: "ghp_rawvalue" },
      { name: "X-Good", value: "secret:gh-token" },
    ];
    expect(describeInjectHeaders(injects, REGISTRY)).toEqual([
      { name: "X-Good", secrets: ["gh-token"] },
    ]);
    expect(renderInjectHeaders(injects, REGISTRY).map((h) => h.name)).toEqual([
      "X-Good",
    ]);
  });
});
