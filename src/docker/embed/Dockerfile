FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates bash docker.io \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /home/naw /nix
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
