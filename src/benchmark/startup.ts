export function summarizeSamples(samples: readonly number[]): {
  min: number;
  median: number;
  max: number;
} {
  if (samples.length === 0) {
    throw new Error("summarizeSamples requires at least one sample");
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
  };
}

export function createMarkerScanner(
  marker: string,
  onOutput: (text: string) => void,
): { push(chunk: string): boolean; finish(): void } {
  if (marker.length === 0) {
    throw new Error("createMarkerScanner requires a non-empty marker");
  }

  let pending = "";
  let matched = false;

  return {
    push(chunk: string): boolean {
      const input = pending + chunk;

      if (matched) {
        if (input.length > 0) onOutput(input);
        pending = "";
        return false;
      }

      const markerIndex = input.indexOf(marker);
      if (markerIndex >= 0) {
        const before = input.slice(0, markerIndex);
        const after = input.slice(markerIndex + marker.length);
        if (before.length > 0) onOutput(before);
        if (after.length > 0) onOutput(after);
        pending = "";
        matched = true;
        return true;
      }

      const retainedLength = findRetainedLength(input, marker);
      const flushLength = input.length - retainedLength;
      if (flushLength > 0) {
        onOutput(input.slice(0, flushLength));
      }
      pending = input.slice(flushLength);
      return false;
    },

    finish(): void {
      if (pending.length > 0) onOutput(pending);
      pending = "";
    },
  };
}

function findRetainedLength(input: string, marker: string): number {
  const maxLength = Math.min(input.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (input.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
