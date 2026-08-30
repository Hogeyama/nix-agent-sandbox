/**
 * 秘密の名前付きレジストリの解決。
 *
 * 設計「秘密の名前付きレジストリ」「秘密の適用範囲」「注入 (Inject)」に対応する。
 *
 * マスク・拒否・注入はどれもこのレジストリの名前を通す。名前を持たない値は
 * `mask` にも `forbid` にも掛からないので、資格情報を注入の直前に組み立てる
 * 経路は持たない。組み立ては `template:` が行い、材料は必ず名前を持つ。
 */

import type {
  Inject,
  SecretConfig,
  SecretDisposition,
} from "../config/types.ts";
import { resolveSecret } from "../hostexec/secret_store.ts";
import {
  type InjectValue,
  injectReferences,
  parseInjectValue,
} from "./authz/config.ts";
import type { InjectHeader, InjectHeaderPreview } from "./protocol.ts";

/**
 * 短すぎる秘密は無関係な内容を巻き込んでマスクするので受け付けない。
 * 4 バイト未満の値は普通の英単語と衝突する。
 */
const MIN_SECRET_BYTES = 4;

/** 名前 → その名前が展開する値。`lines:` は複数の値になる。 */
export type SecretValues = Readonly<Record<string, readonly string[]>>;

export type SecretSourceResolver = (
  source: string,
  env: Record<string, string | undefined>,
) => Promise<string | string[] | null>;

/**
 * レジストリの各エントリを実際の値に解決する。
 *
 * fail-closed: `required` な秘密が取れなければセッションを開始しない。取れない
 * ままマスクを続けると、マスクされるはずの値が素通りする。
 */
export async function resolveSecretRegistry(
  secrets: Readonly<Record<string, SecretConfig>>,
  env: Record<string, string | undefined>,
  resolveSource: SecretSourceResolver = resolveSecret,
): Promise<Record<string, string[]>> {
  const resolved: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(secrets)) {
    const required = config.required !== false;
    let value: string | string[] | null;
    try {
      value = await resolveSource(config.from, env);
    } catch (error) {
      // 取得元の綴りは設定に書いてあるので出してよい。値は出さない。
      throw new Error(
        `[nas] secrets["${name}"] (${config.from}) を解決できませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const values = (
      value === null ? [] : Array.isArray(value) ? value : [value]
    ).filter((entry) => entry !== "");
    if (values.length === 0) {
      if (required) {
        throw new Error(
          `[nas] secrets["${name}"] (${config.from}) が空です。required = false でなければセッションを開始できません。`,
        );
      }
      continue;
    }
    for (const entry of values) {
      assertMinSecretBytes(entry, name);
    }
    resolved[name] = values;
  }
  return resolved;
}

function assertMinSecretBytes(value: string, name: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < MIN_SECRET_BYTES) {
    throw new Error(
      `[nas] secrets["${name}"] の値が ${bytes} バイトしかありません。${MIN_SECRET_BYTES} バイト未満の値は無関係な内容まで巻き込んでマスクします。`,
    );
  }
}

/** 個別の名前は `"*"` に勝つ。どちらも無ければ `mask`。 */
export function dispositionFor(
  dispositions: Readonly<Record<string, SecretDisposition>>,
  name: string,
): SecretDisposition {
  return dispositions[name] ?? dispositions["*"] ?? "mask";
}

/**
 * その帰結で `****` に置換すべき値。
 *
 * `inject` の秘密もここに入る。ボディ・URL・クライアント由来のヘッダーに現れた
 * 場合の扱いは `mask` と同じであり、注入はマスクの後に行うので、注入する値を
 * マスクの対象から外す必要はない。外すと、エージェントが同じ値をボディに書いた
 * 場合にそのまま送出される。
 */
export function maskValuesFor(
  registry: SecretValues,
  dispositions: Readonly<Record<string, SecretDisposition>>,
): string[] {
  return valuesWithDisposition(registry, dispositions, ["mask", "inject"]);
}

/** その帰結で出現を拒否すべき値。 */
export function forbidValuesFor(
  registry: SecretValues,
  dispositions: Readonly<Record<string, SecretDisposition>>,
): string[] {
  return valuesWithDisposition(registry, dispositions, ["forbid"]);
}

function valuesWithDisposition(
  registry: SecretValues,
  dispositions: Readonly<Record<string, SecretDisposition>>,
  wanted: readonly SecretDisposition[],
): string[] {
  const out: string[] = [];
  for (const [name, values] of Object.entries(registry)) {
    if (!wanted.includes(dispositionFor(dispositions, name))) continue;
    out.push(...values);
  }
  return out;
}

/** `inject` を実際のヘッダーに展開する。 */
export function renderInjectHeaders(
  injects: readonly Inject[],
  registry: SecretValues,
): InjectHeader[] {
  const headers: InjectHeader[] = [];
  for (const { name, value } of applicableInjects(injects, registry)) {
    switch (value.kind) {
      case "literal":
        headers.push({ name, value: value.text });
        break;
      case "secret": {
        const secret = singleValue(registry, value.name);
        if (secret !== null) headers.push({ name, value: secret });
        break;
      }
      case "template": {
        const text = value.text.replace(
          /\$\{([^}]*)\}/g,
          (_whole, reference: string) => singleValue(registry, reference) ?? "",
        );
        headers.push({ name, value: text });
        break;
      }
    }
  }
  return headers;
}

/**
 * 承認 UI に見せる注入の姿。
 *
 * 裸のリクエストを通す承認と、資格情報を付けて通す承認は与える権限が別物
 * なので、承認する人はどのヘッダーが足されるかを見られなければならない。
 * 出すのはヘッダー名と参照する秘密の名前だけであり、値は出さない。
 * `literal:` の地の文も出さない。設定に平文の資格情報を書いた設定でも、
 * この経路からは漏れない。
 *
 * 実際に送られない注入をここに出さないために、`renderInjectHeaders` と同じ
 * 選別を通す。画面に出たものと送出されるものが食い違ってはならない。
 */
export function describeInjectHeaders(
  injects: readonly Inject[],
  registry: SecretValues,
): InjectHeaderPreview[] {
  return applicableInjects(injects, registry).map(({ name, value }) => ({
    name,
    secrets: [...injectReferences(value)],
  }));
}

/**
 * 実際に適用される注入だけを、解析済みの値と組にして返す。
 *
 * 解決できない参照があるエントリは落とす。設定エラーの検査が先に通っている
 * ので通常は起こらないが、`required = false` の秘密が実行時に取れなかった
 * 場合にここへ来る。値の一部が空のままヘッダーを組み立てると、`Bearer ` の
 * ような壊れた資格情報を送ることになる。
 */
function applicableInjects(
  injects: readonly Inject[],
  registry: SecretValues,
): { name: string; value: InjectValue }[] {
  const applicable: { name: string; value: InjectValue }[] = [];
  for (const entry of injects) {
    const parsed = parseInjectValue(entry.value);
    if (!parsed.ok) continue;
    if (
      injectReferences(parsed.value).some(
        (name) => singleValue(registry, name) === null,
      )
    ) {
      continue;
    }
    applicable.push({ name: entry.name, value: parsed.value });
  }
  return applicable;
}

/**
 * 注入に使える単一の値。複数の値に展開される秘密は null を返す。
 *
 * どの値を注入するかを選べないので、設定エラーの検査もこの形を拒否する。
 */
function singleValue(registry: SecretValues, name: string): string | null {
  const values = registry[name];
  if (values === undefined || values.length !== 1) return null;
  return values[0] as string;
}

/**
 * maskfs と filter が対象にする秘密。
 *
 * `mask.apply` は名前で絞る。省略時はレジストリの全件になる。ネットワーク側の
 * 絞り込みはスコープとルールの `secrets` が行うので、ここには関わらない。
 */
export function selectAppliedSecrets(
  secrets: Readonly<Record<string, SecretConfig>>,
  apply: readonly string[] | undefined,
): Record<string, SecretConfig> {
  if (apply === undefined) return { ...secrets };
  const selected: Record<string, SecretConfig> = {};
  for (const name of apply) {
    const config = secrets[name];
    if (config !== undefined) selected[name] = config;
  }
  return selected;
}

/** レジストリを解決し、値だけを平らにして返す。maskfs / filter が使う。 */
export async function resolveSecretList(
  secrets: Readonly<Record<string, SecretConfig>>,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  return Object.values(await resolveSecretRegistry(secrets, env)).flat();
}
