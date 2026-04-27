# nas control room (Solid)

Solid implementation of the nas control room UI. Static HTML in
`design/control-room.html` is a visual mock and is not part of the build.

## Dev workflow

Run two processes in parallel.

```sh
# terminal A — bundle + watch
bun run build-ui --watch
# fallback if --watch flakes:
bun --watch run scripts/build_ui.ts

# terminal B — daemon serving the built assets
bun run dev -- ui --port 3939 --no-open
```

Open http://localhost:3939 in a browser.

## Production build

```sh
bun run build-ui
```

Output lands in `src/ui/dist/`.

## Type check

`bun run check` at the repository root type-checks both the daemon and
this frontend (via `tsc -p src/ui/frontend/tsconfig.json`).

## Notes

- Client-side rendered only. There is no SSR or hydration path.
- `tsconfig.json` sets `types: []` because this package never calls
  `Bun.*` APIs directly; the bundler is Bun, not the runtime.
- The build inlines `@xterm/xterm/css/xterm.css` ahead of `src/styles.css`
  so terminal panes render with xterm's base styles, overridable via the
  app stylesheet.
