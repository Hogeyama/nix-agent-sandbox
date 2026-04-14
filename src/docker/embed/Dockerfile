FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates bash docker.io docker-compose-v2 \
  gh ripgrep fd-find python3 python-is-python3 \
  gnupg unzip jq \
  fonts-noto-cjk fonts-noto-color-emoji fontconfig \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Bun (local-proxy 実行用。Node.js より起動が高速)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# ubuntu:24.04 のデフォルト ubuntu ユーザー (UID 1000) を削除。
# ホストユーザーが UID 1000 の場合に entrypoint でのユーザー作成と衝突するため。
RUN userdel -r ubuntu 2>/dev/null && groupdel ubuntu 2>/dev/null || true

COPY entrypoint.sh /entrypoint.sh
COPY local-proxy.mjs /usr/local/bin/local-proxy.mjs
RUN chmod +x /entrypoint.sh

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /home /nix
ENV PATH="/usr/local/bin:${PATH}"

ENTRYPOINT ["/entrypoint.sh"]
