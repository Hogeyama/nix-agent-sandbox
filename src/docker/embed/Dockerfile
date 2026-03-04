FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates bash docker.io docker-compose-v2 \
  gh ripgrep fd-find python3 python-is-python3 nodejs \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /home/nas /nix
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
