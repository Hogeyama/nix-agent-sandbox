import { Context, Effect, Layer } from "effect";
import type { SecretConfig } from "../config/types.ts";
import { resolveSecret } from "../hostexec/secret_store.ts";
import {
  resolveSecretRegistry,
  type SecretSourceResolver,
} from "../network/secrets.ts";

export class SecretResolverService extends Context.Tag(
  "nas/SecretResolverService",
)<
  SecretResolverService,
  {
    readonly resolveRegistry: (
      secrets: Readonly<Record<string, SecretConfig>>,
      env: Record<string, string | undefined>,
    ) => Effect.Effect<Record<string, string[]>, Error>;
  }
>() {}

/** One instance is created per CLI pipeline, so plaintext values never outlive it. */
export function makeSecretResolverService(
  resolveSource: SecretSourceResolver = resolveSecret,
): Context.Tag.Service<SecretResolverService> {
  const cache = new Map<string, Promise<string | string[] | null>>();

  const resolveCached: SecretSourceResolver = (source, env) => {
    const cached = cache.get(source);
    if (cached !== undefined) return cached;

    const pending = resolveSource(source, env);
    cache.set(source, pending);
    return pending;
  };

  return SecretResolverService.of({
    resolveRegistry: (secrets, env) =>
      Effect.tryPromise({
        try: () => resolveSecretRegistry(secrets, env, resolveCached),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  });
}

export const SecretResolverServiceLive = Layer.sync(SecretResolverService, () =>
  makeSecretResolverService(),
);
