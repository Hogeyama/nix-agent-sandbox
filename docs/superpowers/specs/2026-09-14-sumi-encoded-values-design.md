# sumi encoded values

Automatically expand the registered plaintext secrets when loading them. All
sumi consumers (filter, run, post-tool, prompt and init) use the same expanded
patterns. Keep the shared NAS matcher unchanged.

Support URL quote and quote_plus, slash-preserving quote, uppercase and
lowercase percent hex; standard and URL-safe base64, with or without padding.
For values embedded in larger base64 inputs, generate the three independent
alignment substrings, requiring at least eight encoded characters. Include
76-column LF and CRLF wrapping at each possible alignment phase. Preserve the
existing byte-length masking behavior, including for wrapped matches.

Four- to six-byte values have standalone base64 coverage; complete coverage of
all embedded alignments requires seven bytes. Partial matching hides only the
confident encoded interior, not neighboring boundary bits. Mixed-case percent
hex, arbitrary partial encoding, recursive encodings and other wrap widths
remain outside the guarantee. Failure hooks still cannot replace tool errors.

Deduplicate patterns. Bound owned pattern bytes to 64 MiB and count to 262144;
reject excess with a named load error, keeping existing fail-closed behavior.
Validate the original file count and minimum lengths before expansion. Clean up
all intermediate allocations on success and error.

## Why this approach

Pattern expansion reuses the existing streaming and structured-output matchers
and follows the established network mask patterns. Output decoding would need
new parsers and state machines at every consumer. Precomputing bounded variants
keeps this change local to sumi. Fixed 76-column wrap phases avoid an unbounded
set of whitespace combinations while covering the README's base64 command.

## Execution

The user requested autonomous completion through push while away. Implement,
test and review without waiting for interactive design or implementation gates.
