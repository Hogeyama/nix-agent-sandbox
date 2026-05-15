/**
 * OTLP/JSON primitive types and helpers shared by both ingest signals
 * (traces in `ingest.ts` and logs in `ingest_logs.ts`). PII redaction also
 * lives here because both signals strip the same attribute keys. Traces-only
 * or logs-only wire types stay in their respective ingest modules.
 */

// ---------------------------------------------------------------------------
// OTLP/JSON wire types
// ---------------------------------------------------------------------------

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string | number }
  | { boolValue: boolean }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAttributeValue[] } }
  | Record<string, unknown>;

export interface OtlpKeyValue {
  key: string;
  value: OtlpAttributeValue;
}

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

/**
 * OTLP attribute keys that carry user-identifying PII (real email, account ids,
 * hashed user id). Stripped from attrs before persistence; nothing in this
 * codebase consumes them.
 */
export const PII_ATTR_KEYS: ReadonlySet<string> = new Set([
  "user.id",
  "user.email",
  "user.account_id",
  "user.account_uuid",
]);

export function stripPiiAttrs(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (PII_ATTR_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

export function unwrapAttrValue(v: OtlpAttributeValue): unknown {
  if (v === null || typeof v !== "object") return v;
  const obj = v as Record<string, unknown>;
  if (typeof obj.stringValue === "string") return obj.stringValue;
  if (obj.intValue !== undefined) {
    // OTLP/JSON encodes int64 as either string or number; coerce to number.
    const raw = obj.intValue;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
  }
  if (typeof obj.boolValue === "boolean") return obj.boolValue;
  if (typeof obj.doubleValue === "number") return obj.doubleValue;
  if (
    obj.arrayValue !== undefined &&
    typeof obj.arrayValue === "object" &&
    obj.arrayValue !== null
  ) {
    const arr = (obj.arrayValue as { values?: OtlpAttributeValue[] }).values;
    if (Array.isArray(arr)) return arr.map(unwrapAttrValue);
  }
  return v;
}

export function flattenAttributes(
  rawAttrs: ReadonlyArray<OtlpKeyValue> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!rawAttrs) return out;
  for (const kv of rawAttrs) {
    if (typeof kv?.key !== "string") continue;
    out[kv.key] = unwrapAttrValue(kv.value);
  }
  return out;
}

export function readStringAttr(
  attrs: Record<string, unknown>,
  key: string,
): string | null {
  const v = attrs[key];
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * OTLP encodes timestamps as Unix nanoseconds, often as a decimal string to
 * preserve int64 precision. We need an ISO-8601 Z string with millisecond
 * precision (the rest of the schema uses that). Returns null on absent /
 * non-finite input.
 */
export function nanoToIso(nano: string | number | undefined): string | null {
  if (nano === undefined || nano === null) return null;
  let ms: number;
  if (typeof nano === "number") {
    if (!Number.isFinite(nano)) return null;
    ms = Math.floor(nano / 1_000_000);
  } else if (typeof nano === "string") {
    if (nano.length === 0) return null;
    // Use BigInt to avoid losing precision on large nanosecond values, then
    // divide down to milliseconds where Number is sufficient.
    let big: bigint;
    try {
      big = BigInt(nano);
    } catch {
      return null;
    }
    ms = Number(big / 1_000_000n);
  } else {
    return null;
  }
  return new Date(ms).toISOString();
}
