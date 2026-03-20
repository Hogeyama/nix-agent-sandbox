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
          packages = [ pkgs.deno ];
        };

        devShells.moonbit = pkgs.mkShell {
          packages = with pkgs; [ curl gcc ];
          shellHook = ''
            export MOON_HOME="''${MOON_HOME:-$PWD/.moonbit-toolchain}"
            export PATH="$MOON_HOME/bin:$PATH"
            export LIBRARY_PATH="${pkgs.glibc}/lib"
            if [ ! -x "$MOON_HOME/bin/moon" ]; then
              echo "Installing MoonBit toolchain to $MOON_HOME..."
              curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash
              echo "MoonBit installed."
            fi
            echo "MoonBit: $(moon version 2>/dev/null || echo 'not available')"
          '';
        };
      });
}
