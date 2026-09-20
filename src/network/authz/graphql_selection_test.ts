import { describe, expect, test } from "bun:test";
import {
  graphqlPathChain,
  graphqlPathPrefixes,
  isGraphqlFieldPath,
  selectionSatisfies,
} from "./graphql_selection.ts";
import type { GraphqlDocument, GraphqlFieldOccurrence } from "./types.ts";

/** `fieldArguments` の設定形 (Record) を正規化後の Map 形に写す。 */
function condition(
  fieldPaths: readonly string[],
  fieldArguments: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  > = {},
): {
  readonly fieldPaths: readonly string[];
  readonly fieldArguments: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
} {
  return {
    fieldPaths,
    fieldArguments: new Map(
      Object.entries(fieldArguments).map(([path, args]) => [
        path,
        new Map(Object.entries(args)),
      ]),
    ),
  };
}

/** 1 つの出現。既定は引数なしの末端。 */
function occurrence(
  path: string,
  extra: Partial<Omit<GraphqlFieldOccurrence, "path">> = {},
): GraphqlFieldOccurrence {
  return {
    path,
    leaf: true,
    argumentValues: {},
    unresolvedArguments: [],
    ...extra,
  };
}

/** `/a/b/c` の鎖。途中は `leaf = false`、末端だけ `leaf = true`。 */
function chain(
  leaf: string,
  argumentValues: Readonly<Record<string, Record<string, string>>> = {},
  unresolved: Readonly<Record<string, readonly string[]>> = {},
): GraphqlDocument {
  const paths = graphqlPathChain(leaf);
  return {
    operations: ["query"],
    fields: paths.map((path, index) =>
      occurrence(path, {
        leaf: index === paths.length - 1,
        argumentValues: argumentValues[path] ?? {},
        unresolvedArguments: unresolved[path] ?? [],
      }),
    ),
  };
}

describe("isGraphqlFieldPath", () => {
  test("「経路の意味」の文法に一致する経路だけを受ける", () => {
    for (const path of [
      "/repository",
      "/repository/issues/nodes/body",
      "/_node2",
      "/a/_/Z9",
      "/__typename",
      "/__proto__/constructor",
    ]) {
      expect(isGraphqlFieldPath(path)).toBe(true);
    }
  });

  test("ワイルドカード・空の要素・末尾の / ・escape を拒む", () => {
    for (const path of [
      "",
      "/",
      "repository",
      "/repository/",
      "/repository//body",
      "/repository/**",
      "/repository/*",
      "/repository~1issues",
      "/repository/2issues",
      "/repository/iss ues",
      "/repository/issues ",
      "/repository.issues",
      "/repository/nodes/0",
    ]) {
      expect([path, isGraphqlFieldPath(path)]).toEqual([path, false]);
    }
  });
});

describe("graphqlPathChain / graphqlPathPrefixes", () => {
  test("鎖は根から末端まで、接頭辞は末端を含まない", () => {
    expect(graphqlPathChain("/a/b/c")).toEqual(["/a", "/a/b", "/a/b/c"]);
    expect(graphqlPathChain("/a")).toEqual(["/a"]);
    expect([...graphqlPathPrefixes(["/a/b/c", "/a/d"])].sort()).toEqual([
      "/a",
      "/a/b",
    ]);
    // 許可末端そのものは接頭辞ではない。`/a` を許しても `a { b }` は通らない。
    expect(graphqlPathPrefixes(["/a"]).size).toBe(0);
  });
});

describe("selectionSatisfies", () => {
  const owner = condition(["/repository/issues/nodes/body"], {
    "/repository": { owner: ["my-org"] },
  });

  test("許可末端に至る鎖は真になる", () => {
    expect(
      selectionSatisfies(
        owner,
        chain("/repository/issues/nodes/body", {
          "/repository": { owner: "my-org" },
        }),
      ),
    ).toBe("true");
  });

  test("許可末端の部分集合で構成した document も真になる", () => {
    const many = condition([
      "/repository/nameWithOwner",
      "/repository/issues/nodes/body",
    ]);
    expect(selectionSatisfies(many, chain("/repository/nameWithOwner"))).toBe(
      "true",
    );
  });

  test("許可末端の子を足すと偽になる", () => {
    // `/repository/issues/nodes/body` は末端の許可であって、その下の任意の
    // 取得を許す権限ではない。
    expect(
      selectionSatisfies(
        condition(["/repository/issues/nodes/body"]),
        chain("/repository/issues/nodes/body/text"),
      ),
    ).toBe("false");
  });

  test("許可末端の途中で止めた document は偽になる", () => {
    // `repository { issues { ... } }` の `issues` は末端ではないので、
    // 途中の field としては通るが、末端として現れたら完全一致を要する。
    expect(
      selectionSatisfies(
        condition(["/repository/issues/nodes/body"]),
        chain("/repository/issues"),
      ),
    ).toBe("false");
  });

  test("別経路の同名末端は許さない", () => {
    expect(
      selectionSatisfies(
        condition(["/repository/issues/nodes/body"]),
        chain("/repository/parent/issues/nodes/body"),
      ),
    ).toBe("false");
  });

  test("必須引数の欠落・許可外は偽、未解決は判定不能", () => {
    expect(
      selectionSatisfies(owner, chain("/repository/issues/nodes/body")),
    ).toBe("false");
    expect(
      selectionSatisfies(
        owner,
        chain("/repository/issues/nodes/body", {
          "/repository": { owner: "other" },
        }),
      ),
    ).toBe("false");
    expect(
      selectionSatisfies(
        owner,
        chain(
          "/repository/issues/nodes/body",
          {},
          { "/repository": ["owner"] },
        ),
      ),
    ).toBe("indeterminate");
  });

  test("条件が名指ししない引数は制約しない", () => {
    expect(
      selectionSatisfies(
        owner,
        chain(
          "/repository/issues/nodes/body",
          { "/repository": { owner: "my-org", name: "x" } },
          { "/repository/issues": ["first"] },
        ),
      ),
    ).toBe("true");
  });

  test("対象 field が 1 度も現れなければ引数条件は満たされる", () => {
    const both = condition(
      ["/repository/nameWithOwner", "/organization/login"],
      { "/organization": { login: ["my-org"] } },
    );
    expect(selectionSatisfies(both, chain("/repository/nameWithOwner"))).toBe(
      "true",
    );
  });

  test("同じ field が複数あり 1 つだけ不正なら全体が偽になる", () => {
    const document: GraphqlDocument = {
      operations: ["query"],
      fields: [
        ...chain("/repository/issues/nodes/body", {
          "/repository": { owner: "my-org" },
        }).fields,
        ...chain("/repository/issues/nodes/body", {
          "/repository": { owner: "other" },
        }).fields,
      ],
    };
    expect(selectionSatisfies(owner, document)).toBe("false");
  });

  test("判定不能は偽より優先する — 経路が偽でも未解決を見落とさない", () => {
    // 経路違反を見つけた時点で打ち切ると、未解決の owner が偽に化ける。
    // 偽は別ルールへ進めるので、壊れた変数を送るだけで広いルールへ落とせる。
    const document: GraphqlDocument = {
      operations: ["query"],
      fields: [
        ...chain("/organization/login").fields,
        ...chain(
          "/repository/issues/nodes/body",
          {},
          { "/repository": ["owner"] },
        ).fields,
      ],
    };
    expect(selectionSatisfies(owner, document)).toBe("indeterminate");
  });

  test("facts が無い document は判定不能である", () => {
    expect(selectionSatisfies(owner, null)).toBe("indeterminate");
    expect(selectionSatisfies(owner, undefined)).toBe("indeterminate");
    // 末端を 1 つも持たない facts は実在の document から作れない。空集合と
    // して黙って真にしない。
    expect(
      selectionSatisfies(owner, { operations: ["query"], fields: [] }),
    ).toBe("indeterminate");
    expect(
      selectionSatisfies(owner, {
        operations: ["query"],
        fields: [occurrence("/repository", { leaf: false })],
      }),
    ).toBe("indeterminate");
  });

  test("空の fieldPaths は何も許さない (制約なしではない)", () => {
    expect(selectionSatisfies(condition([]), chain("/a"))).toBe("false");
  });

  test("prototype の名前を持つ field と引数を own property として扱う", () => {
    const proto = condition(["/__proto__/constructor"], {
      "/__proto__": { __proto__: ["ok"] },
    });
    expect(
      selectionSatisfies(
        proto,
        chain("/__proto__/constructor", {
          "/__proto__": Object.fromEntries([["__proto__", "ok"]]),
        }),
      ),
    ).toBe("true");
    // 継承した `toString` を「引数がある」と誤認しない。
    expect(
      selectionSatisfies(
        condition(["/a"], { "/a": { toString: ["x"] } }),
        chain("/a"),
      ),
    ).toBe("false");
  });
});
