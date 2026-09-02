interface DocumentTerminalReturnDeps {
  readonly activeHandle: { refit(): void } | null;
  readonly close: () => void;
  readonly requestAnimationFrame: (callback: () => void) => number;
}

export function closeDocumentAndRefitTerminal(
  deps: DocumentTerminalReturnDeps,
): void {
  const handle = deps.activeHandle;
  deps.close();
  if (handle === null) return;
  deps.requestAnimationFrame(() => handle.refit());
}
