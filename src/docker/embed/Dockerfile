FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates bash docker.io docker-compose-v2 \
  gh ripgrep fd-find python3 python-is-python3 nodejs \
  gnupg unzip \
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

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# エージェントバイナリのマウント先
RUN mkdir -p /usr/local/bin /home/nas /nix
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
