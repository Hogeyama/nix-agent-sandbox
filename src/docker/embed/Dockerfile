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
  nixpkgs.fuse-overlayfs \
  nixpkgs.fuse3 \
  nixpkgs.util-linux

# Docker CLI (docker-client のみ。git-minimal との衝突を避けるため別ステップ)
RUN nix-env -iA nixpkgs.docker-client

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /usr/local/lib
ENV PATH="/usr/local/bin:${PATH}"

# 標準共有ライブラリ (非 NixOS ビルドの ELF バイナリ用)
# glibc: ld-linux, libc, libm, libdl, libpthread
# gcc-unwrapped.lib: libstdc++, libgcc_s
RUN GLIBC_PATH=$(nix-build '<nixpkgs>' -A glibc --no-out-link) && \
    GCC_LIB=$(nix-build '<nixpkgs>' -A gcc-unwrapped.lib --no-out-link) && \
    mkdir -p /lib64 && \
    ln -sf "$GLIBC_PATH/lib64/ld-linux-x86-64.so.2" /lib64/ld-linux-x86-64.so.2 && \
    for lib in "$GLIBC_PATH"/lib/lib*.so*; do ln -sf "$lib" /usr/local/lib/; done && \
    for lib in "$GCC_LIB"/lib/lib*.so*; do ln -sf "$lib" /usr/local/lib/; done
ENV LD_LIBRARY_PATH="/usr/local/lib"

# Multi-user Nix: nixbld ビルドユーザーを追加 (nix-daemon がサンドボックスビルドに使用)
RUN mkdir -p /var/empty && \
    echo "nixbld:x:30000:" >> /etc/group && \
    for n in $(seq 1 4); do \
      echo "nixbld${n}:x:$((30000 + n)):30000:Nix build user ${n}:/var/empty:/sbin/nologin" >> /etc/passwd; \
    done && \
    echo "build-users-group = nixbld" >> /etc/nix/nix.conf

# コンテナ内ユーザーの HOME
RUN mkdir -p /home/naw

# コンテナ内の nix store をバックアップ (overlay 用、ビルド時に1回だけ実行)
RUN cp -al /nix/store /nix/store-container

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
