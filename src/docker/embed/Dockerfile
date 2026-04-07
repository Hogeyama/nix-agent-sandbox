FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates bash docker.io docker-compose-v2 \
  gh ripgrep fd-find python3 python-is-python3 \
  gnupg unzip jq \
  fonts-noto-cjk fonts-noto-color-emoji fontconfig \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/google-cloud-cli.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/google-cloud-cli.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
  && cd /tmp && unzip -q awscliv2.zip && ./aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && rm -rf /var/lib/apt/lists/*

# Bun (local-proxy 実行用。Node.js より起動が高速)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# ubuntu:24.04 のデフォルト ubuntu ユーザー (UID 1000) を削除。
# ホストユーザーが UID 1000 の場合に entrypoint でのユーザー作成と衝突するため。
RUN userdel -r ubuntu 2>/dev/null && groupdel ubuntu 2>/dev/null || true

COPY entrypoint.sh /entrypoint.sh
COPY osc52-clip.sh /usr/local/bin/osc52-clip
COPY local-proxy.mjs /usr/local/bin/local-proxy.mjs
RUN chmod +x /entrypoint.sh /usr/local/bin/osc52-clip \
  && ln -s osc52-clip /usr/local/bin/xclip \
  && ln -s osc52-clip /usr/local/bin/xsel \
  && ln -s osc52-clip /usr/local/bin/wl-copy

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /home /nix
ENV PATH="/usr/local/bin:${PATH}"

ENTRYPOINT ["/entrypoint.sh"]
