{
  description = "naw — Nix Agent Sandbox dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
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
