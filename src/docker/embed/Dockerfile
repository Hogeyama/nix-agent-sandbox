FROM nixos/nix:latest AS base

# 基本設定
RUN echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf

# ベースの git-minimal を削除 (nixpkgs.git と衝突するため)
RUN nix-env -e git-minimal 2>/dev/null || true

# 基本ツール
RUN nix-env -iA \
  nixpkgs.git \
  nixpkgs.curl \
  nixpkgs.cacert \
  nixpkgs.bash \
  nixpkgs.nodejs \
  nixpkgs.fuse-overlayfs \
  nixpkgs.fuse3

# Docker CLI (docker-client のみ。git-minimal との衝突を避けるため別ステップ)
RUN nix-env -iA nixpkgs.docker-client

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin
ENV PATH="/usr/local/bin:${PATH}"

# 標準パスの ld-linux (非 NixOS ビルドの ELF バイナリ用)
RUN mkdir -p /lib64 && \
    GLIBC_PATH=$(nix-build '<nixpkgs>' -A glibc --no-out-link 2>/dev/null) && \
    ln -sf "$GLIBC_PATH/lib64/ld-linux-x86-64.so.2" /lib64/ld-linux-x86-64.so.2

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
