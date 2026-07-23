import type {
  EncodedField,
  JsonRequestPolicy,
  RequestPolicy,
  ReviewRule,
  ReviewRuleSpec,
  TaggedUnionGuard,
} from "../config/types.ts";
import type { NormalizedTarget } from "./protocol.ts";
import {
  matchesHostPattern,
  matchesPathPrefix,
  normalizeHost,
  parseAllowlistEntry,
} from "./protocol.ts";

const SAFE_ID_PREFIX = /^[a-z][a-z0-9._-]{0,63}/;
const JSON_LIMITS = {
  maxBodyBytes: 33_554_432,
  maxDepth: 64,
  maxNodes: 200_000,
  maxDecodedBytes: 33_554_432,
} as const;

export interface ResolvedReviewRule {
  id?: string;
  method?: string;
  host?: string;
  path?: string;
  pathPrefix?: string;
  action: "allow" | "review" | "deny";
  audit: boolean;
  requestPolicy?: RequestPolicy;
}

export interface ResolvedReviewRules {
  contractVersion: 1;
  rules: ResolvedReviewRule[];
}

export interface ReviewRuleMatchInput {
  method: string;
  target: NormalizedTarget;
  path: string;
}

interface IndexedResolvedReviewRule {
  sourceIndex: number;
  rule: ResolvedReviewRule;
}

/**
 * Compile raw custom rules into the closed, versioned runtime contract.
 *
 * Preset expansion is deliberately outside this task's custom-rule compiler.
 * The preset compiler extends this entry point in the next implementation
 * step.
 */
export function resolveReviewRules(
  specs: ReviewRuleSpec[],
): ResolvedReviewRules {
  const compiled: IndexedResolvedReviewRule[] = [];
  const errors: string[] = [];

  specs.forEach((spec, index) => {
    if ("preset" in spec) {
      errors.push(
        `${ruleLabel(index, spec.id)}: preset "${spec.preset}" is not supported`,
      );
      return;
    }
    try {
      validateRule(spec, index);
      compiled.push({ sourceIndex: index, rule: cloneRule(spec) });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });

  errors.push(...validateUniqueIdsAndEndpoints(compiled));
  errors.push(...validateProtectedShadowing(compiled));
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  return { contractVersion: 1, rules: compiled.map(({ rule }) => rule) };
}

/** First-match-compatible matching for a single resolved review rule. */
export function matchesReviewRule(
  rule: Pick<ResolvedReviewRule, "method" | "host" | "path" | "pathPrefix">,
  request: ReviewRuleMatchInput,
): boolean {
  if (
    rule.method !== undefined &&
    rule.method.toUpperCase() !== request.method.toUpperCase()
  ) {
    return false;
  }
  if (
    rule.host !== undefined &&
    !matchesHostPattern(request.target, [rule.host])
  ) {
    return false;
  }
  if (rule.path !== undefined) {
    const queryIndex = request.path.indexOf("?");
    const queryFreePath =
      queryIndex === -1 ? request.path : request.path.slice(0, queryIndex);
    if (queryFreePath !== rule.path) return false;
  }
  if (
    rule.pathPrefix !== undefined &&
    !matchesPathPrefix(request.path, rule.pathPrefix)
  ) {
    return false;
  }
  return true;
}

/**
 * Return true only when every request matched by `later` is provably matched
 * by `earlier`. Action and audit fields intentionally do not participate.
 */
export function reviewRuleSubsumes(
  earlier: Pick<ResolvedReviewRule, "method" | "host" | "path" | "pathPrefix">,
  later: Pick<ResolvedReviewRule, "method" | "host" | "path" | "pathPrefix">,
): boolean {
  if (!methodSubsumes(earlier.method, later.method)) return false;
  if (!hostSubsumes(earlier.host, later.host)) return false;
  return pathSubsumes(earlier, later);
}

function validateRule(rule: ReviewRule, index: number): void {
  const label = ruleLabel(index, rule.id);
  if (rule.id !== undefined && !isSafeId(rule.id)) {
    throw new Error(
      `${label}: invalid rule ID; expected [a-z][a-z0-9._-]{0,63}`,
    );
  }
  if (rule.path !== undefined && rule.pathPrefix !== undefined) {
    throw new Error(`${label}: path and pathPrefix are mutually exclusive`);
  }
  if (rule.path?.includes("?")) {
    throw new Error(`${label}: path must be query-free`);
  }
  if (rule.requestPolicy === undefined) return;

  const missing = (["id", "method", "host", "path"] as const).filter(
    (field) => rule[field] === undefined || rule[field] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `${label}: requestPolicy requires exact id, method, host, and path; missing ${missing.join(", ")}`,
    );
  }
  if (
    rule.host === undefined ||
    rule.method === undefined ||
    !isExactNonPortHost(rule.host)
  ) {
    throw new Error(`${label}: requestPolicy requires an exact non-port host`);
  }
  if (rule.action === "deny") {
    throw new Error(`${label}: deny rules may not carry requestPolicy`);
  }

  validateRequestPolicy(rule.requestPolicy, rule.method, label);
}

function validateRequestPolicy(
  policy: RequestPolicy,
  method: string,
  label: string,
): void {
  if (policy.kind === "bodyless") {
    if (method.toUpperCase() !== "GET") {
      throw new Error(`${label}: bodyless requestPolicy requires method GET`);
    }
    return;
  }
  if (policy.kind !== "json") {
    const kind = (policy as { kind?: unknown }).kind;
    throw new Error(`${label}: unknown requestPolicy kind "${String(kind)}"`);
  }
  if (method.toUpperCase() !== "POST") {
    throw new Error(`${label}: json requestPolicy requires method POST`);
  }
  validateJsonPolicy(policy, label);
}

function validateJsonPolicy(policy: JsonRequestPolicy, label: string): void {
  for (const field of Object.keys(JSON_LIMITS) as Array<
    keyof typeof JSON_LIMITS
  >) {
    const value = policy[field];
    if (!Number.isInteger(value) || value <= 0 || value > JSON_LIMITS[field]) {
      throw new Error(
        `${label}: requestPolicy.${field} must be a positive integer at most ${JSON_LIMITS[field]}`,
      );
    }
  }
  if (!Array.isArray(policy.taggedUnions)) {
    throw new Error(`${label}: requestPolicy.taggedUnions must be a list`);
  }
  if (!Array.isArray(policy.encodedFields)) {
    throw new Error(`${label}: requestPolicy.encodedFields must be a list`);
  }

  policy.taggedUnions.forEach((guard, index) => {
    const guardLabel = `${label}: requestPolicy.taggedUnions[${index}]`;
    validateSelector(guard.at, `${guardLabel}.at`);
    requireNonEmptyString(guard.discriminator, `${guardLabel}.discriminator`);
    if (
      !Array.isArray(guard.allowedTags) ||
      guard.allowedTags.length === 0 ||
      guard.allowedTags.some(
        (tag) => typeof tag !== "string" || tag.length === 0,
      )
    ) {
      throw new Error(
        `${guardLabel}.allowedTags must contain non-empty strings`,
      );
    }
  });

  policy.encodedFields.forEach((field, index) => {
    const fieldLabel = `${label}: requestPolicy.encodedFields[${index}]`;
    validateSelector(field.at, `${fieldLabel}.at`);
    requireNonEmptyString(field.whenField, `${fieldLabel}.whenField`);
    requireNonEmptyString(field.whenEquals, `${fieldLabel}.whenEquals`);
    requireNonEmptyString(field.dataField, `${fieldLabel}.dataField`);
    if (field.encoding !== "base64") {
      throw new Error(`${fieldLabel}.encoding must be base64`);
    }
  });
}

function validateSelector(selector: string, label: string): void {
  if (typeof selector !== "string" || !selector.startsWith("/")) {
    throw new Error(
      `${label}: invalid selector; expected JSON Pointer pattern`,
    );
  }
  for (const segment of selector.slice(1).split("/")) {
    if (/(?:~(?![01]))|~$/.test(segment)) {
      throw new Error(`${label}: invalid selector escape`);
    }
    if (
      segment !== "*" &&
      segment !== "**" &&
      /^[a-z0-9_.~-]*\*+[a-z0-9_.~-]*$/i.test(segment)
    ) {
      throw new Error(
        `${label}: invalid selector wildcard; * and ** must occupy a whole segment`,
      );
    }
  }
}

function validateUniqueIdsAndEndpoints(
  rules: IndexedResolvedReviewRule[],
): string[] {
  const errors: string[] = [];
  const ids = new Map<string, number>();
  const endpoints = new Map<string, number>();

  rules.forEach(({ rule, sourceIndex }) => {
    if (rule.id !== undefined) {
      const earlier = ids.get(rule.id);
      if (earlier !== undefined) {
        errors.push(
          `${ruleLabel(sourceIndex, rule.id)}: duplicate rule ID also used by reviewRules[${earlier}]`,
        );
      } else {
        ids.set(rule.id, sourceIndex);
      }
    }

    if (
      rule.method !== undefined &&
      rule.host !== undefined &&
      rule.path !== undefined
    ) {
      const endpoint = exactEndpointKey(rule.method, rule.host, rule.path);
      if (endpoint === null) return;
      const earlier = endpoints.get(endpoint);
      if (earlier !== undefined) {
        errors.push(
          `${ruleLabel(sourceIndex, rule.id)}: duplicate exact endpoint also used by reviewRules[${earlier}]`,
        );
      } else {
        endpoints.set(endpoint, sourceIndex);
      }
    }
  });
  return errors;
}

function exactEndpointKey(
  method: string,
  host: string,
  path: string,
): string | null {
  try {
    const parsed = parseAllowlistEntry(host);
    return JSON.stringify([
      method.toUpperCase(),
      normalizeHost(parsed.host),
      parsed.port,
      path,
    ]);
  } catch {
    return null;
  }
}

function validateProtectedShadowing(
  rules: IndexedResolvedReviewRule[],
): string[] {
  const errors: string[] = [];
  rules.forEach(({ rule, sourceIndex }, index) => {
    if (rule.requestPolicy === undefined) return;
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex++) {
      const earlier = rules[earlierIndex];
      if (reviewRuleSubsumes(earlier.rule, rule)) {
        errors.push(
          `reviewRules[${earlier.sourceIndex}] shadows protected ${ruleLabel(sourceIndex, rule.id)}`,
        );
        break;
      }
    }
  });
  return errors;
}

function cloneRule(rule: ReviewRule): ResolvedReviewRule {
  return {
    ...rule,
    audit: rule.audit ?? true,
    requestPolicy:
      rule.requestPolicy === undefined
        ? undefined
        : cloneRequestPolicy(rule.requestPolicy),
  };
}

function cloneRequestPolicy(policy: RequestPolicy): RequestPolicy {
  if (policy.kind === "bodyless") return { kind: "bodyless" };
  return {
    ...policy,
    taggedUnions: policy.taggedUnions.map(cloneTaggedUnion),
    encodedFields: policy.encodedFields.map(cloneEncodedField),
  };
}

function cloneTaggedUnion(guard: TaggedUnionGuard): TaggedUnionGuard {
  return { ...guard, allowedTags: [...guard.allowedTags] };
}

function cloneEncodedField(field: EncodedField): EncodedField {
  return { ...field };
}

function methodSubsumes(
  earlier: string | undefined,
  later: string | undefined,
): boolean {
  if (later === undefined) return earlier === undefined;
  return earlier === undefined || earlier.toUpperCase() === later.toUpperCase();
}

function hostSubsumes(
  earlier: string | undefined,
  later: string | undefined,
): boolean {
  if (later === undefined) return earlier === undefined;
  if (!isExactNonPortHost(later)) return false;
  if (earlier === undefined) return true;

  try {
    const parsedEarlier = parseAllowlistEntry(earlier);
    const parsedLater = parseAllowlistEntry(later);
    if (parsedEarlier.port !== null || parsedLater.port !== null) return false;

    const laterHost = normalizeHost(parsedLater.host);
    if (parsedEarlier.host.startsWith("*.")) {
      const candidate = normalizeHost(parsedEarlier.host.slice(2));
      return laterHost === candidate || laterHost.endsWith(`.${candidate}`);
    }
    return normalizeHost(parsedEarlier.host) === laterHost;
  } catch {
    return false;
  }
}

function pathSubsumes(
  earlier: Pick<ResolvedReviewRule, "path" | "pathPrefix">,
  later: Pick<ResolvedReviewRule, "path" | "pathPrefix">,
): boolean {
  if (later.path === undefined && later.pathPrefix === undefined) {
    return earlier.path === undefined && earlier.pathPrefix === undefined;
  }
  if (later.path !== undefined) {
    if (earlier.path === undefined && earlier.pathPrefix === undefined) {
      return true;
    }
    if (earlier.path !== undefined) return earlier.path === later.path;
    if (earlier.pathPrefix === undefined) return false;
    return matchesPathPrefix(later.path, earlier.pathPrefix);
  }

  if (earlier.path === undefined && earlier.pathPrefix === undefined) {
    return true;
  }
  if (earlier.path !== undefined) return false;
  if (earlier.pathPrefix === undefined || later.pathPrefix === undefined) {
    return false;
  }
  return matchesPathPrefix(later.pathPrefix, earlier.pathPrefix);
}

function isSafeId(id: string): boolean {
  const match = id.match(SAFE_ID_PREFIX);
  return match?.[0] === id;
}

function isExactNonPortHost(host: string): boolean {
  if (host !== host.trim()) return false;
  const dnsHost = host.endsWith(".") ? host.slice(0, -1) : host;
  if (dnsHost.length === 0 || dnsHost.length > 253) return false;
  return dnsHost
    .split(".")
    .every(
      (label) =>
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    );
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function ruleLabel(index: number, id: string | undefined): string {
  return id === undefined
    ? `reviewRules[${index}]`
    : `reviewRules[${index}] (id "${id}")`;
}
