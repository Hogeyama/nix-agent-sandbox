import { Effect } from "effect";

/** Await an owned command's cancellation before releasing the caller's Scope. */
export function ownedCommand<A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, Error> {
  return Effect.async<A, Error>((resume) => {
    const controller = new AbortController();
    const running = run(controller.signal);
    running.then(
      (value) => resume(Effect.succeed(value)),
      (error) =>
        resume(
          Effect.fail(
            error instanceof Error ? error : new Error(String(error)),
          ),
        ),
    );
    return Effect.promise(async () => {
      controller.abort();
      // The failure is already observed above. Interruption wins the Effect
      // outcome, but process teardown must settle before outer finalizers.
      await Promise.allSettled([running]);
    });
  });
}
