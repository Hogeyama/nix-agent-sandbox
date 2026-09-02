import { For, type JSX } from "solid-js";
import type { MarkdownNode } from "./markdownView";

interface MarkdownNodesProps {
  nodes: readonly MarkdownNode[];
}

function MarkdownElement(props: {
  node: Extract<MarkdownNode, { kind: "element" }>;
}): JSX.Element {
  const children = () => <MarkdownNodes nodes={props.node.children} />;
  switch (props.node.tag) {
    case "p":
      return <p>{children()}</p>;
    case "h1":
      return <h1>{children()}</h1>;
    case "h2":
      return <h2>{children()}</h2>;
    case "h3":
      return <h3>{children()}</h3>;
    case "h4":
      return <h4>{children()}</h4>;
    case "h5":
      return <h5>{children()}</h5>;
    case "h6":
      return <h6>{children()}</h6>;
    case "strong":
      return <strong>{children()}</strong>;
    case "em":
      return <em>{children()}</em>;
    case "del":
      return <del>{children()}</del>;
    case "code":
      return <code>{children()}</code>;
    case "pre":
      return <pre>{children()}</pre>;
    case "blockquote":
      return <blockquote>{children()}</blockquote>;
    case "ul":
      return <ul>{children()}</ul>;
    case "ol":
      return <ol start={props.node.start}>{children()}</ol>;
    case "li":
      return <li>{children()}</li>;
    case "table":
      return <table>{children()}</table>;
    case "thead":
      return <thead>{children()}</thead>;
    case "tbody":
      return <tbody>{children()}</tbody>;
    case "tr":
      return <tr>{children()}</tr>;
    case "th":
      return <th>{children()}</th>;
    case "td":
      return <td>{children()}</td>;
    case "hr":
      return <hr />;
    case "br":
      return <br />;
    case "span":
      return <span class="document-code-language">{children()}</span>;
    default: {
      const exhaustive: never = props.node.tag;
      return exhaustive;
    }
  }
}

function MarkdownNodeView(props: { node: MarkdownNode }): JSX.Element {
  switch (props.node.kind) {
    case "text":
      return props.node.value;
    case "element":
      return <MarkdownElement node={props.node} />;
    case "task-marker":
      return (
        <span class="document-task-marker" aria-hidden="true">
          {props.node.checked ? "☑" : "☐"}
        </span>
      );
    case "link":
      return (
        <a
          href={props.node.href}
          title={props.node.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          <MarkdownNodes nodes={props.node.children} />
        </a>
      );
    case "placeholder":
      switch (props.node.role) {
        case "image":
          return (
            <span class="document-placeholder document-placeholder-image">
              {props.node.value}
            </span>
          );
        case "link":
          return (
            <span class="document-placeholder document-placeholder-link">
              {props.node.value}
            </span>
          );
        case "html":
          return (
            <span class="document-placeholder document-placeholder-html">
              {props.node.value}
            </span>
          );
        default: {
          const exhaustive: never = props.node.role;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = props.node;
      return exhaustive;
    }
  }
}

export function MarkdownNodes(props: MarkdownNodesProps) {
  return (
    <For each={props.nodes}>{(node) => <MarkdownNodeView node={node} />}</For>
  );
}
