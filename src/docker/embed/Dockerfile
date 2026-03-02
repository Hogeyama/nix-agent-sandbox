FROM nixos/nix:latest AS base

# 基本設定
RUN echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf

# 基本ツール
RUN nix-env -iA \
  nixpkgs.git \
  nixpkgs.curl \
  nixpkgs.cacert \
  nixpkgs.bash \
  nixpkgs.nodejs \
  nixpkgs.docker \
  nixpkgs.fuse-overlayfs

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
