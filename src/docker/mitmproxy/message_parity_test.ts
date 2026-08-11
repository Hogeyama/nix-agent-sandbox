/**
 * addon が送るメッセージを、broker の検証器がそのまま受け取れること。
 *
 * 違反の確認は 2 プロセスに跨る。addon がボディを検査して所見を組み立て、
 * broker がそれを検証してから人に出す。broker はフィールド 1 つ知らないだけで
 * メッセージを丸ごと拒み、addon は拒まれたリクエストを通さないので、形の
 * ずれは「間違った答え」ではなく「動かないセッション」になる。
 *
 * 片側だけのテストではこれを捕まえられない。python 側は自分が作った dict を
 * 見るだけで、TypeScript 側は手で書いた所見を見るだけだからである。ここでは
 * **実際の検査が出した**所見からメッセージを組み立てさせ、broker の検証器に
 * 通す。
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedDocument } from "../../network/authz/resolve.ts";
import {
  validateAuthorizeRequest,
  validateRequestPolicyOutcome,
  validateRequestPolicyReview,
} from "../../network/protocol.ts";

const python3 = Bun.which("python3");
const addonDir = path.dirname(new URL(import.meta.url).pathname);

const MASK_VALUES = ["s3cret-value"];

/** Claude Code が送る形に、その場で足したタグを混ぜたボディ。 */
function body(extraContent: unknown[]): string {
  return JSON.stringify({
    model: "claude-opus-4-20250514",
    max_tokens: 8192,
    system: [{ type: "text", text: "You are Claude Code." }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi s3cret-value" }, ...extraContent],
      },
    ],
  });
}

async function messagesFor(requestBody: string): Promise<{
  result: string;
  reason: string;
  authorize: unknown;
  review: unknown;
  outcome: unknown;
}> {
  const proc = Bun.spawn(
    [
      python3 as string,
      "message_parity.py",
      requestBody,
      JSON.stringify(MASK_VALUES),
    ],
    {
      cwd: addonDir,
      env: {
        ...process.env,
        PYTHONPATH: path.join(addonDir, "testdata", "mitmproxy_stub"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`message_parity.py failed: ${stderr}`);
  return JSON.parse(stdout);
}

test.skipIf(!python3)(
  "the broker accepts the authorization truth table the addon builds",
  async () => {
    const document = await shippedDocument();
    const { authorize } = await messagesFor(body([]));

    expect(validateAuthorizeRequest(authorize, "sess_parity", document)).toBe(
      null,
    );
    expect(authorize).toMatchObject({
      bodyTruth: { "anthropic.messages": "true" },
      reviewContext: {
        path: "/v1/messages",
        contentType: "application/json",
      },
    });
    expect(JSON.stringify(authorize)).not.toContain("bodyKind");
  },
);

async function shippedDocument(): Promise<ResolvedDocument> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../network/fixtures/authz/anthropic-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ResolvedDocument;
}

test.skipIf(!python3)(
  "the broker accepts the review query the addon builds",
  async () => {
    const document = await shippedDocument();
    const { result, review } = await messagesFor(
      body([
        { type: "future_block", note: "s3cret-value" },
        { type: "another_future_block" },
        // 同じタグの 2 件目は件数に畳まれるので、所見は 2 件になる。
        { type: "future_block" },
      ]),
    );

    expect(result).toEqual("review");
    expect(validateRequestPolicyReview(review, "sess_parity", document)).toBe(
      null,
    );
    const findings = (review as { findings: { value: string }[] }).findings;
    expect(findings.map((f) => f.value)).toEqual([
      "future_block",
      "another_future_block",
    ]);
    expect(JSON.stringify(review)).not.toContain("s3cret-value");
  },
);

test.skipIf(!python3)(
  "the broker accepts the outcome report the addon builds",
  async () => {
    const document = await shippedDocument();
    const { outcome } = await messagesFor(
      body([{ type: "future_block", note: "s3cret-value" }]),
    );

    expect(validateRequestPolicyOutcome(outcome, "sess_parity", document)).toBe(
      null,
    );
  },
);

test.skipIf(!python3)(
  "a value too long to keep whole still fits what the broker accepts",
  async () => {
    // 値はボディ由来なので、長さはリクエストが選ぶ。addon は畳んで digest を
    // 付けるが、その結果が broker の長さの天井を超えていたら、押せるはずの
    // 違反が丸ごと拒まれる。
    const document = await shippedDocument();
    const { review } = await messagesFor(body([{ type: "x".repeat(20_000) }]));

    expect(validateRequestPolicyReview(review, "sess_parity", document)).toBe(
      null,
    );
  },
);

test.skipIf(!python3)(
  "a body the policy accepts produces no violation to confirm",
  async () => {
    const { result, outcome } = await messagesFor(body([]));
    const document = await shippedDocument();

    expect(result).toEqual("rewrite");
    expect((outcome as { findings: unknown[] }).findings).toEqual([]);
    expect(validateRequestPolicyOutcome(outcome, "sess_parity", document)).toBe(
      null,
    );
  },
);
