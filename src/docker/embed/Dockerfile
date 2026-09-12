# 26.04 以上が必要: JVM が信頼済み証明書として認識する PKCS12 truststore の
# 生成 (entrypoint.sh の openssl pkcs12 -jdktrust) に OpenSSL 3.2+ が要る。
FROM ubuntu:26.04

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates bash docker.io docker-compose-v2 \
  gh ripgrep fd-find python3 python-is-python3 \
  gnupg unzip jq direnv \
  fonts-noto-cjk fonts-noto-color-emoji fontconfig \
  locales \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
  && locale-gen en_US.UTF-8 ja_JP.UTF-8 \
  && update-locale LANG=en_US.UTF-8 \
  && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# Bun (local-proxy 実行用。Node.js より起動が高速)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# ubuntu イメージのデフォルト ubuntu ユーザー (UID 1000) を削除。
# ホストユーザーが UID 1000 の場合に entrypoint でのユーザー作成と衝突するため。
RUN userdel -r ubuntu 2>/dev/null && groupdel ubuntu 2>/dev/null || true

COPY entrypoint.sh /entrypoint.sh
COPY direnv-exec.sh /usr/local/bin/nas-direnv-exec
COPY direnv-bootstrap.sh /usr/local/libexec/nas-direnv-bootstrap
COPY direnv-lib.sh nix-direnv.sh /usr/local/share/nas/
COPY nix-direnv.LICENSE /usr/local/share/licenses/nix-direnv/LICENSE
COPY local-proxy.mjs /usr/local/bin/local-proxy.mjs
RUN printf '%s  %s\n' \
      '856e8d0b5247b9edc88d9377b8333a97a2363cc69abaa7760fb857609d597ebe' \
      '/usr/local/share/nas/nix-direnv.sh' | sha256sum -c - \
  && chmod +x /entrypoint.sh /usr/local/bin/nas-direnv-exec \
    /usr/local/libexec/nas-direnv-bootstrap

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /home /nix
ENV PATH="/usr/local/bin:${PATH}"

ENTRYPOINT ["/entrypoint.sh"]
