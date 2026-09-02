import { describe, expect, test } from "bun:test";
import {
  buildMarkdownView,
  type MarkdownNode,
  type SafeTag,
} from "./markdownView";

function walk(
  nodes: readonly MarkdownNode[],
  visit: (node: MarkdownNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "element" || node.kind === "link") {
      walk(node.children, visit);
    }
  }
}

function allElementTags(nodes: readonly MarkdownNode[]): SafeTag[] {
  const tags: SafeTag[] = [];
  walk(nodes, (node) => {
    if (node.kind === "element") tags.push(node.tag);
  });
  return tags;
}

function allText(nodes: readonly MarkdownNode[]): string {
  let value = "";
  walk(nodes, (node) => {
    if (node.kind === "text" || node.kind === "placeholder") {
      value += node.value;
    }
  });
  return value;
}

function findLinks(nodes: readonly MarkdownNode[]): Array<{
  href: string;
  target: "_blank";
  rel: "noopener noreferrer";
}> {
  const links: Array<{
    href: string;
    target: "_blank";
    rel: "noopener noreferrer";
  }> = [];
  walk(nodes, (node) => {
    if (node.kind === "link") {
      links.push({
        href: node.href,
        target: "_blank",
        rel: "noopener noreferrer",
      });
    }
  });
  return links;
}

describe("buildMarkdownView", () => {
  test("maps headings and ordinary inline Markdown to closed safe nodes", () => {
    const nodes = buildMarkdownView(
      "# Guide\n\nUse **strong**, *emphasis*, ~~removed~~, and `code`.  \nNext.\n\n---",
    );

    expect(allElementTags(nodes)).toEqual([
      "h1",
      "p",
      "strong",
      "em",
      "del",
      "code",
      "br",
      "hr",
    ]);
    expect(allText(nodes)).toContain("Guide");
    expect(allText(nodes)).toContain("strong");
    expect(allText(nodes)).toContain("Next.");
  });

  test("maps fenced code and exposes its language as text, never an attribute", () => {
    const nodes = buildMarkdownView(
      "```typescript onmouseover=alert(1)\nconst x = '<safe>';\n```",
    );

    expect(nodes).toEqual([
      {
        kind: "element",
        tag: "pre",
        children: [
          {
            kind: "element",
            tag: "span",
            children: [
              { kind: "text", value: "typescript onmouseover=alert(1)" },
            ],
          },
          {
            kind: "element",
            tag: "code",
            children: [{ kind: "text", value: "const x = '<safe>';" }],
          },
        ],
      },
    ]);
  });

  test("maps blockquotes and ordered, unordered, and task lists", () => {
    const nodes = buildMarkdownView(`
> Quoted **text**

3. third
4. fourth

- plain
- [x] done
- [ ] pending
`);

    expect(allElementTags(nodes)).toEqual([
      "blockquote",
      "p",
      "strong",
      "ol",
      "li",
      "li",
      "ul",
      "li",
      "li",
      "li",
    ]);
    const ordered = nodes.find(
      (node) => node.kind === "element" && node.tag === "ol",
    );
    expect(ordered).toMatchObject({ kind: "element", tag: "ol", start: 3 });

    const markers: boolean[] = [];
    walk(nodes, (node) => {
      if (node.kind === "task-marker") markers.push(node.checked);
    });
    expect(markers).toEqual([true, false]);
  });

  test("maps GFM tables without carrying alignment into attributes", () => {
    const nodes = buildMarkdownView(`
| Name | State |
| :--- | ---: |
| **build** | ready |
`);

    expect(allElementTags(nodes)).toEqual([
      "table",
      "thead",
      "tr",
      "th",
      "th",
      "tbody",
      "tr",
      "td",
      "strong",
      "td",
    ]);
    expect(allText(nodes)).toContain("build");
    expect(allText(nodes)).toContain("ready");
  });

  test("keeps hostile HTML, images, and unsafe links inert and visible", () => {
    const nodes = buildMarkdownView(`
<script>fetch("https://evil.invalid")</script>
![secret](https://evil.invalid/pixel.png)
[safe](https://example.com/x)
[relative](./other.md)
[js](javascript:alert(1))
`);

    expect(allElementTags(nodes)).not.toContain("img" as SafeTag);
    expect(allElementTags(nodes)).not.toContain("script" as SafeTag);
    expect(findLinks(nodes)).toEqual([
      {
        href: "https://example.com/x",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ]);
    expect(allText(nodes)).toContain(
      '<script>fetch("https://evil.invalid")</script>',
    );
    expect(allText(nodes)).toContain(
      "Image: secret — https://evil.invalid/pixel.png",
    );
    expect(allText(nodes)).toContain("./other.md");
    expect(allText(nodes)).toContain("javascript:alert(1)");
  });

  test("preserves nested formatting and escaped punctuation as text", () => {
    const nodes = buildMarkdownView(
      "> **bold with _nested emphasis_ and [docs](https://example.com/docs)** plus \\*literal stars\\*",
    );

    expect(allElementTags(nodes)).toEqual(["blockquote", "p", "strong", "em"]);
    expect(findLinks(nodes)).toEqual([
      {
        href: "https://example.com/docs",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ]);
    expect(allText(nodes)).toContain("*literal stars*");
  });

  test("degrades malformed Markdown to visible text", () => {
    const nodes = buildMarkdownView(
      "Unclosed **strong and [broken](< target plus <unknown attr='x'",
    );

    expect(allText(nodes)).toContain("Unclosed **strong");
    expect(allText(nodes)).toContain("[broken](<");
    expect(allText(nodes)).toContain("<unknown attr='x'");
  });
});
