import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { chromium } from "playwright";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const chromiumAvailable = await access(chromium.executablePath()).then(
  () => true,
  () => false,
);

test.skipIf(!chromiumAvailable)(
  "hostexec approval card keeps long evidence and controls within a 240px pane",
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 640, height: 900 },
      });
      await page.setContent(`
        <aside class="pane pane-right" style="width: 240px; height: 900px">
          <div class="content">
            <article class="card">
              <dl class="hostexec-match">
                <div class="hostexec-match-row"><dt>Rule</dt><dd>repository.git.push.with-a-very-long-rule-identifier</dd></div>
                <div class="hostexec-match-row"><dt>Command</dt><dd>"git" "push" "origin" "feature/very-long-branch-name-that-must-wrap"</dd></div>
                <div class="hostexec-match-row"><dt>Working directory</dt><dd>/home/developer/workspaces/a-very-long-project-directory/checkout</dd></div>
                <div class="hostexec-match-row"><dt>Environment bindings</dt><dd>GITHUB_TOKEN_WITH_A_VERY_LONG_NAME ← secret:github-token-with-a-very-long-source-name</dd></div>
                <div class="hostexec-match-row"><dt>Inherited environment</dt><dd>unsafe-inherit-all; SSH_AUTH_SOCK_WITH_A_LONG_NAME, GIT_CONFIG_GLOBAL</dd></div>
              </dl>
              <section aria-label="Approve scope">
                <div class="scope-row hostexec-scope-row">
                  <button class="scope hostexec-scope">This request only</button>
                  <button class="scope hostexec-scope selected">Matching command for this session</button>
                </div>
                <p class="card-ask-reason">Approves all requests waiting on these exact conditions and remembers them for future requests in this session.</p>
                <div class="action-row hostexec-approve"><button class="action approve">Approve</button></div>
              </section>
              <div class="action-row hostexec-deny"><button class="action deny">Deny this request only</button></div>
            </article>
          </div>
        </aside>
      `);
      await page.addStyleTag({ content: styles });

      const layout = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>(".pane-right");
        const card = document.querySelector<HTMLElement>(".card");
        if (!pane || !card) throw new Error("layout fixture did not render");
        const cardRect = card.getBoundingClientRect();
        const overflowing = [
          ...card.querySelectorAll<HTMLElement>("dt, dd, button"),
        ]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left < cardRect.left - 0.5 ||
              rect.right > cardRect.right + 0.5
            );
          })
          .map((element) => element.textContent?.trim());
        const labelWidths = [
          ...card.querySelectorAll<HTMLElement>(".hostexec-match-row dt"),
        ].map((element) => element.getBoundingClientRect().width);
        return {
          paneClientWidth: pane.clientWidth,
          paneScrollWidth: pane.scrollWidth,
          cardClientWidth: card.clientWidth,
          cardScrollWidth: card.scrollWidth,
          overflowing,
          labelWidths,
        };
      });

      expect(layout.paneClientWidth).toBe(240);
      expect(layout.paneScrollWidth).toBe(layout.paneClientWidth);
      expect(layout.cardScrollWidth).toBe(layout.cardClientWidth);
      expect(layout.overflowing).toEqual([]);
      expect(layout.labelWidths.every((width) => width >= 80)).toBe(true);
    } finally {
      await browser.close();
    }
  },
);

test.skipIf(!chromiumAvailable)(
  "document review contains wide content without overflowing the center pane",
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 900, height: 600 },
      });
      await page.setContent(`
        <section class="pane pane-center" style="width: 900px; height: 600px; opacity: 1; transform: none; animation: none">
          <article class="document-pane">
            <header class="document-header">
              <span class="document-path">docs/a-very-long-segment-without-breaks-that-must-wrap/a-second-very-long-segment-without-breaks-that-must-wrap/review.markdown</span>
              <span class="document-location">line 1024, column 72</span>
            </header>
            <div class="document-markdown">
              <table>
                <thead><tr><th>Identifier</th><th>Evidence</th></tr></thead>
                <tbody><tr><td>row-one</td><td>one_extremely_wide_table_cell_that_must_scroll_without_expanding_the_center_pane_${"x".repeat(120)}</td></tr></tbody>
              </table>
              <pre><code>const anExtremelyWideValue = "${"code".repeat(100)}";</code></pre>
            </div>
            <div class="document-source">
              <div class="document-source-row" data-source-line="1"><span class="document-source-number">1</span><code>${"source-without-breaks-".repeat(50)}</code></div>
              <div class="document-source-row document-source-highlighted" data-source-line="2"><span class="document-source-number">2</span><code>requested line</code></div>
            </div>
          </article>
        </section>
      `);
      await page.addStyleTag({ content: styles });

      const layout = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>(".pane-center");
        const documentPane =
          document.querySelector<HTMLElement>(".document-pane");
        const table = document.querySelector<HTMLElement>(
          ".document-markdown table",
        );
        const pre = document.querySelector<HTMLElement>(
          ".document-markdown pre",
        );
        if (!pane || !documentPane || !table || !pre) {
          throw new Error("document layout fixture did not render");
        }
        const horizontalScrollers = [
          ...documentPane.querySelectorAll<HTMLElement>("*"),
        ]
          .filter((element) => element.scrollWidth > element.clientWidth)
          .map((element) =>
            element.tagName === "TABLE"
              ? "table"
              : element.tagName === "PRE"
                ? "pre"
                : `${element.tagName.toLowerCase()}.${element.className}`,
          );
        return {
          paneClientWidth: pane.clientWidth,
          paneScrollWidth: pane.scrollWidth,
          documentClientWidth: documentPane.clientWidth,
          documentScrollWidth: documentPane.scrollWidth,
          tableScrollable: table.scrollWidth > table.clientWidth,
          preScrollable: pre.scrollWidth > pre.clientWidth,
          horizontalScrollers,
        };
      });

      expect(layout.paneClientWidth).toBe(900);
      expect(layout.paneScrollWidth).toBe(layout.paneClientWidth);
      expect(layout.documentScrollWidth).toBe(layout.documentClientWidth);
      expect(layout.tableScrollable).toBe(true);
      expect(layout.preScrollable).toBe(true);
      expect(layout.horizontalScrollers).toEqual(["table", "pre"]);
    } finally {
      await browser.close();
    }
  },
);
