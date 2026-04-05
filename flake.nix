{
  description = "nas — Nix Agent Sandbox";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Phase 1: Fetch all dependencies into DENO_DIR (Fixed Output Derivation)
        nas-deps = pkgs.stdenv.mkDerivation {
          name = "nas-deps";
          src = self;
          nativeBuildInputs = [ pkgs.deno ];

          # FOD: needs network, output is hash-checked
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-qjdxUThheqR1Z1aIQ5iMIQkGr9tVGFKQl4y/3MdIVX4=";

          buildPhase = ''
            export DENO_DIR="$out"
            export HOME=$(mktemp -d)

            # Cache all source dependencies (main app + build script + frontend)
            deno cache --lock=deno.lock main.ts
            deno cache --lock=deno.lock scripts/build_ui.ts
            deno cache --lock=deno.lock src/ui/frontend/src/main.tsx

            # Pre-cache the denort runtime binary that deno compile needs
            echo 'Deno.exit(0)' > /tmp/_dummy.ts
            deno compile --output /tmp/_dummy /tmp/_dummy.ts

            # Make DENO_DIR deterministic by normalizing volatile artifacts.
            # WARNING: This is based on reverse-engineering Deno's internal
            # cache format and may break on Deno version upgrades. If the FOD
            # hash starts changing again or Phase 2 fails after a Deno update,
            # inspect the new cache layout (see git log for the investigation).
            #
            # 1. Remote cached files have a trailing denoCacheMetadata comment
            #    with per-request HTTP headers and timestamps. Normalize to
            #    keep only url + content-type (needed for module resolution).
            # 2. SQLite analysis caches have non-deterministic page metadata.
            # 3. npm registry.json responses contain volatile fields.
            deno eval '
              for (const host of ["deno.land","jsr.io","esm.sh","dl.deno.land"]) {
                const dir = Deno.args[0]+"/remote/https/"+host;
                try { for (const e of Deno.readDirSync(dir)) {
                  if (!e.isFile) continue;
                  const p = dir+"/"+e.name;
                  const t = Deno.readTextFileSync(p);
                  const i = t.lastIndexOf("\n// denoCacheMetadata=");
                  if (i < 0) continue;
                  const j = JSON.parse(t.slice(i+22));
                  const h = {};
                  const ct = j.headers?.["content-type"];
                  if (ct) h["content-type"] = ct;
                  Deno.writeTextFileSync(p,
                    t.slice(0,i)+"\n// denoCacheMetadata="+
                    JSON.stringify({headers:h,time:0,url:j.url}));
                } } catch {}
              }
            ' "$out"
            find "$out" -name '*_cache_v2*' -delete
            find "$out/npm" -name 'registry.json' -delete
          '';

          # The output IS the DENO_DIR
          installPhase = "true";
        };

        # Phase 2: Build the binary using cached deps
        nas = pkgs.stdenv.mkDerivation {
          pname = "nas";
          version = "0.1.0";
          src = self;
          nativeBuildInputs = [ pkgs.deno ];

          # deno compile embeds JS in a custom ELF section; strip destroys it
          dontStrip = true;

          buildPhase = ''
            export DENO_DIR=$(mktemp -d)
            export HOME=$(mktemp -d)

            # Copy cached deps (read-only store → writable tmpdir)
            cp -r ${nas-deps}/* "$DENO_DIR/"
            chmod -R u+w "$DENO_DIR"

            # Build UI + compile standalone binary (--cached-only, no network)
            deno task compile:cached
          '';

          installPhase = ''
            mkdir -p $out/bin
            cp nas $out/bin/
          '';
        };
      in
      {
        packages.default = nas;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.deno
            pkgs.pnpm
            pkgs.chromium
          ];

          shellHook = ''
            if [ ! -f .playwright/cli.config.json ]; then
              mkdir -p .playwright
              cat > .playwright/cli.config.json <<EOF
            {
              "browser": {
                "browserName": "chromium",
                "launchOptions": {
                  "executablePath": "${pkgs.chromium}/bin/chromium",
                  "args": ["--force-device-scale-factor=2"],
                  "chromiumSandbox": false
                }
              }
            }
            EOF
            fi
          '';
        };
      });
}
