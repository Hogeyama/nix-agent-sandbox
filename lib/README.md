# Shared native libraries

Put code used by multiple executables here. Executable entry points, CLI parsing,
and product-specific protocols stay with their product.

| Library | Owns | Used by |
| --- | --- | --- |
| `masking/` | Byte-pattern masking and incremental stream masking | maskfs, mask-filter, sumi, process-supervisor |
| `process-supervisor/` | Child-process supervision, output draining, the masking-broker relay client and server, ADDR parsing (Unix path, `unix://`, loopback `tcp://`), the TCP listener and direct/proxy TCP connect, and the framed broker input protocol | mask-filter, sumi |

`masking/root.zig` exposes `mask` and `stream`. Import it as the `masking`
module. `process-supervisor/supervise.zig` is the `supervise` module and depends
on `masking`; it exposes the broker server as `supervise.serve`. Neither library imports product sources.

Product code remains in `src/mask-filter/`, `src/hostexec/intercept/`,
`contrib/maskfs/`, and `contrib/sumi/`. The broker server (`serve.zig`), its client (`relay.zig`), the address parser
(`address.zig`) and the frame codec (`frame.zig`) all live in
`process-supervisor/`; each product reads its own secrets format and passes
the values to `supervise.serve.run`.

## Verify a change

Run these commands from the repository root in the Nix development environment:

```sh
bun run test:masking-unit
bun run test:process-supervisor-unit
bun run test:mask-filter-unit
bun run test:hostexec-unit
bun run test:sumi-unit
bun run test:sumi-integration
```

`bun run test:unit` includes both shared libraries and the product unit suites.
The shared libraries have their own test roots: importing them into a product
does not run their tests. Nix checks for mask-filter and sumi also run the shared
suites so moving tests into a library does not remove packaging checks.

For compatibility, `cd contrib/maskfs && zig build test` still runs the shared
masking suite. It does not test the FUSE filesystem itself; those end-to-end tests
live in `tests/maskfs_e2e_test.ts` and belong to `test:nas-integration`.
