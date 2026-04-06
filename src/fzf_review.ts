/**
 * Shared fzf-based interactive review for pending approval requests.
 */

export interface ReviewItem {
  sessionId: string;
  requestId: string;
  displayLine: string;
}

export interface ReviewResult {
  action: "approve" | "deny";
  items: ReviewItem[];
  scope?: string;
}

/**
 * Spawns fzf for a simple single-selection from a list of options.
 * Returns null if the user cancelled.
 */
async function fzfSelect(
  options: string[],
  prompt: string,
  header?: string,
): Promise<string | null> {
  const input = options.join("\n") + "\n";
  const args = ["--prompt=" + prompt, "--no-sort"];
  if (header) args.push("--header=" + header);

  const child = Bun.spawn(["fzf", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  (child.stdin as import("bun").FileSink).write(
    new TextEncoder().encode(input),
  );
  (child.stdin as import("bun").FileSink).end();

  const stdoutText = await new Response(child.stdout as ReadableStream).text();
  const code = await child.exited;
  if (code === 130 || code === 1) return null;
  if (code !== 0) throw new Error(`fzf exited with code ${code}`);

  const result = stdoutText.trimEnd();
  return result || null;
}

/**
 * Spawns fzf with the given items for interactive multi-selection.
 * Returns null if the user cancelled or no items were selected.
 *
 * If scopeOptions is provided and the user chooses "approve",
 * a second fzf prompt lets them pick the approval scope.
 *
 * Key bindings:
 *   Enter  → approve selected items
 *   Ctrl-D → deny selected items
 *   Esc    → cancel
 */
export async function runFzfReview(
  items: ReviewItem[],
  scopeOptions?: string[],
): Promise<ReviewResult | null> {
  const input = items.map((i) => i.displayLine).join("\n") + "\n";

  const lookup = new Map<string, ReviewItem>();
  for (const item of items) {
    lookup.set(item.displayLine, item);
  }

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([
      "fzf",
      "--multi",
      "--expect=enter,ctrl-d",
      "--header=Tab: select | Enter: approve | Ctrl-D: deny | Esc: cancel",
      "--prompt=review> ",
      "--no-sort",
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
  } catch {
    throw new Error("fzf is not installed. Install it to use 'review'.");
  }

  (child.stdin as import("bun").FileSink).write(
    new TextEncoder().encode(input),
  );
  (child.stdin as import("bun").FileSink).end();

  const stdoutText = await new Response(child.stdout as ReadableStream).text();
  const code = await child.exited;

  // exit code 130 = Esc/Ctrl-C, 1 = no match
  if (code === 130 || code === 1) {
    return null;
  }
  if (code !== 0) {
    throw new Error(`fzf exited with code ${code}`);
  }

  const lines = stdoutText.trimEnd().split("\n");
  if (lines.length < 2) return null;

  const key = lines[0].trim();
  const action: "approve" | "deny" = key === "ctrl-d" ? "deny" : "approve";

  const selectedItems: ReviewItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const item = lookup.get(lines[i]);
    if (item) {
      selectedItems.push(item);
    }
  }

  if (selectedItems.length === 0) return null;

  // If approving and scope options are available, prompt for scope
  let scope: string | undefined;
  if (action === "approve" && scopeOptions && scopeOptions.length > 0) {
    const selected = await fzfSelect(
      scopeOptions,
      "scope> ",
      "Select approval scope (Esc: cancel)",
    );
    if (selected === null) return null;
    scope = selected;
  }

  return { action, items: selectedItems, scope };
}
