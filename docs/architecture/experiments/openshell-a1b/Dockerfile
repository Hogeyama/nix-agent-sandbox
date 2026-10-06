FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /sandbox
WORKDIR /sandbox
