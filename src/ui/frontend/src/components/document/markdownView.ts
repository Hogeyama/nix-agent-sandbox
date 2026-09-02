import { marked, type Token, type Tokens } from "marked";

export type SafeTag =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "strong"
  | "em"
  | "del"
  | "code"
  | "pre"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "hr"
  | "br"
  | "span";

export type MarkdownNode =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "element";
      readonly tag: SafeTag;
      readonly children: readonly MarkdownNode[];
      readonly start?: number;
    }
  | { readonly kind: "task-marker"; readonly checked: boolean }
  | {
      readonly kind: "link";
      readonly href: string;
      readonly title: string | null;
      readonly children: readonly MarkdownNode[];
    }
  | {
      readonly kind: "placeholder";
      readonly role: "image" | "link" | "html";
      readonly value: string;
    };

function text(value: string): MarkdownNode {
  return { kind: "text", value };
}

function element(
  tag: SafeTag,
  children: readonly MarkdownNode[] = [],
  start?: number,
): MarkdownNode {
  return start === undefined
    ? { kind: "element", tag, children }
    : { kind: "element", tag, children, start };
}

function headingTag(depth: number): SafeTag | null {
  switch (depth) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
    case 4:
      return "h4";
    case 5:
      return "h5";
    case 6:
      return "h6";
    default:
      return null;
  }
}

function explicitHttpUrl(href: string): string | null {
  if (href.trim() !== href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

function inlineText(tokens: readonly Token[]): string {
  let value = "";
  for (const token of tokens) {
    if (token.type === "br") {
      value += "\n";
    } else if (token.type === "html") {
      value += token.raw;
    } else if ("tokens" in token && token.tokens) {
      value += inlineText(token.tokens);
    } else if ("text" in token && typeof token.text === "string") {
      value += token.text;
    } else {
      value += token.raw;
    }
  }
  return value;
}

function mapInline(tokens: readonly Token[]): MarkdownNode[] {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        return textToken.tokens
          ? mapInline(textToken.tokens)
          : [text(textToken.text)];
      }
      case "escape":
        return [text((token as Tokens.Escape).text)];
      case "strong":
        return [element("strong", mapInline((token as Tokens.Strong).tokens))];
      case "em":
        return [element("em", mapInline((token as Tokens.Em).tokens))];
      case "del":
        return [element("del", mapInline((token as Tokens.Del).tokens))];
      case "codespan":
        return [element("code", [text((token as Tokens.Codespan).text)])];
      case "br":
        return [element("br")];
      case "checkbox":
        return [
          {
            kind: "task-marker",
            checked: (token as Tokens.Checkbox).checked,
          },
        ];
      case "html":
        return [{ kind: "placeholder", role: "html", value: token.raw }];
      case "image": {
        const image = token as Tokens.Image;
        return [
          {
            kind: "placeholder",
            role: "image",
            value: `Image: ${image.text || "(no alt text)"} — ${image.href}`,
          },
        ];
      }
      case "link": {
        const link = token as Tokens.Link;
        const href = explicitHttpUrl(link.href);
        return href === null
          ? [
              {
                kind: "placeholder",
                role: "link",
                value: `${inlineText(link.tokens)} — ${link.href}`,
              },
            ]
          : [
              {
                kind: "link",
                href,
                title: link.title ?? null,
                children: mapInline(link.tokens),
              },
            ];
      }
      default:
        return [text(token.raw)];
    }
  });
}

function mapTable(token: Tokens.Table): MarkdownNode {
  const header = element("tr", [
    ...token.header.map((cell) => element("th", mapInline(cell.tokens))),
  ]);
  const rows = token.rows.map((row) =>
    element(
      "tr",
      row.map((cell) => element("td", mapInline(cell.tokens))),
    ),
  );
  return element("table", [element("thead", [header]), element("tbody", rows)]);
}

function mapBlocks(tokens: readonly Token[]): MarkdownNode[] {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "heading": {
        const heading = token as Tokens.Heading;
        const tag = headingTag(heading.depth);
        return tag === null
          ? [text(heading.raw)]
          : [element(tag, mapInline(heading.tokens))];
      }
      case "paragraph":
        return [element("p", mapInline((token as Tokens.Paragraph).tokens))];
      case "text": {
        const textToken = token as Tokens.Text;
        return textToken.tokens
          ? mapInline(textToken.tokens)
          : [text(textToken.text)];
      }
      case "code": {
        const code = token as Tokens.Code;
        const children: MarkdownNode[] = [];
        if (code.lang) {
          children.push(element("span", [text(code.lang)]));
        }
        children.push(element("code", [text(code.text)]));
        return [element("pre", children)];
      }
      case "blockquote":
        return [
          element("blockquote", mapBlocks((token as Tokens.Blockquote).tokens)),
        ];
      case "list": {
        const list = token as Tokens.List;
        const children = list.items.map((item) =>
          element("li", mapBlocks(item.tokens)),
        );
        const start =
          list.ordered && typeof list.start === "number"
            ? list.start
            : undefined;
        return [element(list.ordered ? "ol" : "ul", children, start)];
      }
      case "table":
        return [mapTable(token as Tokens.Table)];
      case "hr":
        return [element("hr")];
      case "html":
        return [{ kind: "placeholder", role: "html", value: token.raw }];
      case "strong":
      case "em":
      case "del":
      case "codespan":
      case "br":
      case "checkbox":
      case "image":
      case "link":
      case "escape":
        return mapInline([token]);
      default:
        return [text(token.raw)];
    }
  });
}

export function buildMarkdownView(markdown: string): readonly MarkdownNode[] {
  return mapBlocks(marked.lexer(markdown, { gfm: true, breaks: false }));
}
