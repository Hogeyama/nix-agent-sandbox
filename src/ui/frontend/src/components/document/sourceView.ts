export interface SourceLine {
  readonly number: number;
  readonly text: string;
  readonly highlighted: boolean;
}

export interface SourceView {
  readonly lines: readonly SourceLine[];
  readonly scrollLine: number | null;
}

export function buildSourceView(
  content: string,
  requestedLine: number | null,
): SourceView {
  const sourceLines = content.split("\n");
  const scrollLine =
    requestedLine === null
      ? null
      : Math.min(sourceLines.length, Math.max(1, Math.trunc(requestedLine)));
  const lines = sourceLines.map((line, index) => ({
    number: index + 1,
    text: line,
    highlighted: index + 1 === scrollLine,
  }));
  return { lines, scrollLine };
}
