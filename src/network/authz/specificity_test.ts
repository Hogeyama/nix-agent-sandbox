import { describe, expect, test } from "bun:test";
import { type CompiledMatch, compileMatch, parseTarget } from "./relation.ts";
import {
  compareSpecificity,
  compareTargetSpecificity,
  evaluationOrder,
  precedenceOrder,
} from "./specificity.ts";
import type { Match, Target } from "./types.ts";

function compile(match: Match): CompiledMatch {
  const compiled = compileMatch(match);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.value;
}

function targets(...sources: readonly string[]): readonly Target[] {
  return sources.map((source) => {
    const parsed = parseTarget(source);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
}

describe("compareSpecificity", () => {
  test("受理集合が真部分集合なら特異である", () => {
    const narrow = compile({ methods: ["GET"], paths: ["/repos/a"] });
    const wide = compile({ paths: ["/repos/**"] });
    expect(compareSpecificity(narrow, wide)).toBe("narrower");
    expect(compareSpecificity(wide, narrow)).toBe("wider");
  });

  test("互いに包含するなら決着しない", () => {
    const star = compile({ paths: ["/a/*"] });
    const capture = compile({ paths: ["/a/{n}"] });
    expect(compareSpecificity(star, capture)).toBe("equivalent");
  });

  test("交差するのにどちらも包含しない組は比較不能になる", () => {
    // 設計「設定エラーの提示」の例。github.repos.read と github.repos.pulls。
    const read = compile({
      methods: ["GET", "HEAD"],
      paths: ["/repos/{org}/{repo}/**"],
      captures: { org: ["my-org"] },
    });
    const pulls = compile({ methods: ["GET"], paths: ["/repos/*/*/pulls"] });
    expect(compareSpecificity(read, pulls)).toBe("incomparable");
  });

  test("交差しない組も比較不能になる", () => {
    const json = compile({ paths: ["/v1/ping"], body: { format: "json" } });
    const none = compile({ paths: ["/v1/ping"], body: { format: "none" } });
    expect(compareSpecificity(json, none)).toBe("incomparable");
  });

  test("equals はその値を含む oneOf より特異である", () => {
    const narrow = compile({
      paths: ["/run"],
      body: { format: "json", equals: { "/mode": "fast" } },
    });
    const wide = compile({
      paths: ["/run"],
      body: { format: "json", oneOf: { "/mode": ["fast", "safe"] } },
    });
    expect(compareSpecificity(narrow, wide)).toBe("narrower");
    expect(compareSpecificity(wide, narrow)).toBe("wider");
  });
});

describe("compareTargetSpecificity", () => {
  test("包含関係があるときは特異な側が勝つ", () => {
    expect(
      compareTargetSpecificity(
        targets("api.github.com"),
        targets("*.github.com"),
      ),
    ).toBe("narrower");
  });

  test("ホストとポートで向きが逆なら比較不能になる", () => {
    expect(
      compareTargetSpecificity(
        targets("a.example.com"),
        targets("*.example.com:8443"),
      ),
    ).toBe("incomparable");
  });
});

describe("evaluationOrder", () => {
  const rule = (id: string, match: Match) => ({ id, compiled: compile(match) });

  function idsOf(rules: readonly { id: string; compiled: CompiledMatch }[]) {
    const outcome = evaluationOrder(rules, (item) => item.compiled);
    if (!outcome.ok)
      throw new Error(`並べられなかった: ${outcome.cycle.length}`);
    return outcome.ordered.map((item) => item.id);
  }

  test("特異度の降順に評価する", () => {
    const rules = [
      rule("wide", { paths: ["/repos/**"] }),
      rule("narrow", { paths: ["/repos/a/b"] }),
      rule("middle", { paths: ["/repos/a/**"] }),
    ];
    expect(idsOf(rules)).toEqual(["narrow", "middle", "wide"]);
  });

  test("特異度で決着しない組は宣言順で評価する", () => {
    // "json" と "none" は互いを包含せず交差もしないので、設定エラーにならないまま
    // 比較不能に残る。判定不能による打ち切りで相対順序が観測できるため、宣言順で
    // 全順序を与える。
    const rules = [
      rule("ping.none", { paths: ["/v1/ping"], body: { format: "none" } }),
      rule("ping.json", { paths: ["/v1/ping"], body: { format: "json" } }),
    ];
    expect(idsOf(rules)).toEqual(["ping.none", "ping.json"]);
  });

  test("宣言順は特異度を覆さない", () => {
    const rules = [
      rule("wide", { paths: ["/**"] }),
      rule("unrelated", { paths: ["/other"], methods: ["POST"] }),
      rule("narrow", { paths: ["/a"] }),
    ];
    const ordered = idsOf(rules);
    expect(ordered.indexOf("narrow")).toBeLessThan(ordered.indexOf("wide"));
    expect(ordered).toHaveLength(3);
  });
});

describe("precedenceOrder", () => {
  test("閉路があるときは順序を作らず、閉路そのものを返す", () => {
    // 「並べられなかった」を宣言順に潰すと、閉路に加わっていない c まで宣言順に
    // 落ちる。順序で安全側を決めている呼び手にはそれが静かな緩みになる。
    const outcome = precedenceOrder(
      ["a", "b", "c"],
      (from, to) =>
        (from === "a" && to === "b") || (from === "b" && to === "a"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("閉路を検出できていない");
    expect([...outcome.cycle].sort()).toEqual(["a", "b"]);
  });

  test("3 要素の輪も検出する", () => {
    const ring: Record<string, string> = { a: "b", b: "c", c: "a" };
    const outcome = precedenceOrder(
      ["a", "b", "c"],
      (from, to) => ring[from] === to,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("閉路を検出できていない");
    expect([...outcome.cycle].sort()).toEqual(["a", "b", "c"]);
  });
});
