#!/usr/bin/env bash
# Standalone host feasibility probe. Does not modify host configuration.
set -euo pipefail

case "${1:-host}" in
  host)
    uname -sr
    grep "^PRETTY_NAME=" /etc/os-release
    bwrap --version
    nas_probe_dir=$(mktemp -d -t nas-bwrap-mapping-XXXXXXXX)
    trap 'rm -rf -- "$nas_probe_dir"' EXIT
    mkdir -p "$nas_probe_dir/public"
    printf 'host-only-sentinel\n' > "$nas_probe_dir/public/secret.txt"
    printf 'masked\n' > "$nas_probe_dir/masked"
    printf 'nasprobe:x:1000:1000:Probe:/root:/bin/sh\n' > "$nas_probe_dir/passwd"
    export NAS_PROBE_DOCKER_TEST="${2:-false}"
    nas_probe_script=$(readlink -f "$0")
    nas_probe_path=''
    for nas_probe_tool in bash bwrap unshare mount umount id cat mkdir sleep timeout docker dockerd grep tail env stat ip curl node; do
      nas_probe_binary=$(readlink -f "$(command -v "$nas_probe_tool")")
      nas_probe_path="${nas_probe_path:+$nas_probe_path:}${nas_probe_binary%/*}"
    done
    export NAS_PROBE_DIR="$nas_probe_dir" NAS_PROBE_SCRIPT="$nas_probe_script" NAS_PROBE_PATH="$nas_probe_path"
    export NAS_PROBE_BASH
    NAS_PROBE_BASH=$(readlink -f "$(command -v bash)")
    if test "$NAS_PROBE_DOCKER_TEST" = true; then
      nas_probe_rootlesskit=${3:?pass the rootlesskit executable as argument 3}
      "$nas_probe_rootlesskit" --version
      timeout --signal=TERM --kill-after=5s 60s "$nas_probe_rootlesskit" \
        --state-dir="$nas_probe_dir/rootlesskit" --net=none --port-driver=none \
        --pidns --reaper=true --copy-up=/etc --copy-up=/run \
        "$NAS_PROBE_BASH" "$nas_probe_script" outer
      exit
    fi
    timeout --signal=TERM --kill-after=5s 60s unshare --user --map-auto --map-root-user --mount --pid --fork --kill-child --mount-proc \
      "$NAS_PROBE_BASH" "$nas_probe_script" outer
    ;;
  outer)
    printf 'outer UID map:\n'
    cat /proc/self/uid_map
    nas_probe_extra_mounts=()
    if test "$NAS_PROBE_DOCKER_TEST" = true; then
      nas_probe_extra_mounts=(--ro-bind "$ROOTLESSKIT_STATE_DIR/api.sock" /rootlesskit/api.sock
        --ro-bind "${NAS_PROBE_SCRIPT%/*}/node_modules/probe-artifacts" /probe-artifacts
        --ro-bind "${NAS_PROBE_SCRIPT%/*}/testcontainers-probe.mjs" /testcontainers-probe.mjs)
    fi
    exec bwrap "${nas_probe_extra_mounts[@]}" --unshare-pid --unshare-net --unshare-ipc --unshare-uts --cap-add ALL \
      --ro-bind /nix/store /nix/store \
      --ro-bind "$NAS_PROBE_SCRIPT" /probe.sh \
      --ro-bind "$NAS_PROBE_DIR/public" /fixture \
      --ro-bind "$NAS_PROBE_DIR/masked" /fixture/secret.txt \
      --ro-bind "$NAS_PROBE_DIR/passwd" /etc/passwd --ro-bind /sys /sys --proc /proc --dev /dev --tmpfs /tmp --dir /root --dir /etc \
      --clearenv --setenv PATH "$NAS_PROBE_PATH" --setenv HOME /root \
      --setenv NAS_PROBE_BASH "$NAS_PROBE_BASH" --setenv NAS_PROBE_DOCKER_TEST "$NAS_PROBE_DOCKER_TEST" --chdir / --die-with-parent --new-session \
      -- "$NAS_PROBE_BASH" /probe.sh mapped
    ;;
  mapped)
    printf 'after bwrap UID map:\n'
    cat /proc/self/uid_map
    cat /proc/self/gid_map
    grep -E '^(Cap|NoNewPrivs)' /proc/self/status
    exec unshare --user --map-users=0:0:1 --map-users=1:1:65535 --map-groups=0:0:1 --map-groups=1:1:65535 \
      --mount --net --pid --fork --kill-child --mount-proc "$NAS_PROBE_BASH" /probe.sh inner
    ;;
  inner)
    ip link set lo up
    printf 'inner UID map:\n'
    cat /proc/self/uid_map
    id
    grep -E '^(Cap|NoNewPrivs)' /proc/self/status
    mkdir /tmp/mount-test
    mount -t tmpfs tmpfs /tmp/mount-test
    printf 'PASS nested tmpfs mount\n'
    umount /tmp/mount-test
    test "$(cat /fixture/secret.txt)" = masked
    if umount /fixture/secret.txt; then
      printf 'FAIL protected mount could be removed\n'
      exit 1
    fi
    test "$(cat /fixture/secret.txt)" = masked
    if mount -o remount,bind,rw /fixture; then
      printf 'FAIL fixture could be made writable\n'
      exit 1
    fi
    printf 'PASS inherited mask and readonly mounts resist removal\n'
    test ! -e /home
    test ! -e /run/docker.sock
    test ! -e /run/user
    printf 'PASS host home and Docker sockets absent\n'
    printf 'docker version: '
    docker --version
    printf 'dockerd version: '
    dockerd --version
    if test "$NAS_PROBE_DOCKER_TEST" = true; then
      export ROOTLESSKIT_STATE_DIR=/rootlesskit
      export XDG_RUNTIME_DIR=/tmp/run
      mkdir -p "$XDG_RUNTIME_DIR" /tmp/docker-data /tmp/docker-exec
      export DOCKER_HOST=unix:///tmp/run/docker.sock
      dockerd --rootless --host="$DOCKER_HOST" --data-root=/tmp/docker-data \
        --exec-root=/tmp/docker-exec --pidfile=/tmp/run/docker.pid \
        --storage-driver=vfs --iptables=false --ip6tables=false --bip=172.30.199.1/24 \
        --ip-forward=false --ip-masq=false --userland-proxy=true \
        > /tmp/dockerd.log 2>&1 &
      nas_probe_daemon=$!
      trap 'kill -TERM "$nas_probe_daemon" 2>/dev/null || true; wait "$nas_probe_daemon" 2>/dev/null || true' EXIT
      nas_probe_ready=false
      for ((nas_probe_attempt=0; nas_probe_attempt<40; nas_probe_attempt++)); do
        if docker info --format '{{json .SecurityOptions}}' > /tmp/docker-info 2>/dev/null; then
          nas_probe_ready=true
          break
        fi
        if ! kill -0 "$nas_probe_daemon" 2>/dev/null; then break; fi
        sleep 0.5
      done
      if test "$nas_probe_ready" != true; then
        tail -30 /tmp/dockerd.log
        exit 1
      fi
      cat /tmp/docker-info
      printf 'PASS dedicated Docker daemon started inside nested boundary\n'
      docker import --change 'CMD ["/fixture"]' /probe-artifacts/fixture.tar nas-bwrap-probe:local
      nas_probe_identity=$(docker run --rm --network=none nas-bwrap-probe:local /fixture hello)
      test "$nas_probe_identity" = 'fixture uid=0 gid=0'
      nas_probe_identity=$(docker run --rm --network=none --user 1234:1234 nas-bwrap-probe:local /fixture hello)
      test "$nas_probe_identity" = 'fixture uid=1234 gid=1234'

      printf 'PASS offline containers run as root and UID 1234\n'
      docker run --rm --privileged --network=host --pid=host \
        --security-opt seccomp=unconfined -v /sys:/sys:ro -v /:/outside \
        nas-bwrap-probe:local /fixture check-boundary
      docker run -d --name http-probe -p 127.0.0.1::8080 nas-bwrap-probe:local
      nas_probe_address=$(docker port http-probe 8080/tcp)
      bwrap --unshare-user --uid 1000 --gid 1000 --unshare-pid --cap-drop ALL \
        --ro-bind /nix/store /nix/store --proc /proc --dev /dev --tmpfs /tmp \
        --clearenv --setenv PATH "$PATH" --chdir / --die-with-parent \
        -- curl --silent --show-error --noproxy '*' --fail --max-time 5 "http://$nas_probe_address/"
      docker rm -f http-probe
      printf 'PASS published dynamic port reachable from restricted bwrap client\n'
      docker load --input /probe-artifacts/ryuk.tar
      bwrap --unshare-user --uid 1000 --gid 1000 --unshare-pid --cap-drop ALL \
        --ro-bind /nix/store /nix/store --proc /proc --dev /dev --tmpfs /tmp --dir /root \
        --ro-bind /etc/passwd /etc/passwd \
        --ro-bind /probe-artifacts /probe-artifacts \
        --ro-bind /testcontainers-probe.mjs /testcontainers-probe.mjs \
        --ro-bind /tmp/run/docker.sock /var/run/docker.sock \
        --clearenv --setenv PATH "$PATH" --setenv HOME /root \
        --setenv DOCKER_HOST unix:///var/run/docker.sock \
        --setenv TESTCONTAINERS_HOST_OVERRIDE 127.0.0.1 \
        --setenv TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE /tmp/run/docker.sock \
        --setenv TESTCONTAINERS_RYUK_RECONNECTION_TIMEOUT 1s \
        --chdir / --die-with-parent -- node /testcontainers-probe.mjs
      nas_probe_reaped=false
      for ((nas_probe_attempt=0; nas_probe_attempt<30; nas_probe_attempt++)); do
        nas_probe_remaining=$(docker ps -aq --filter name=nas-probe-ryuk-cleanup)
        if test -z "$nas_probe_remaining"; then
          nas_probe_reaped=true
          break
        fi
        sleep 0.5
      done
      test "$nas_probe_reaped" = true
      printf 'PASS Ryuk removed container after SDK process exit\n'
    fi
    ;;
  *) exit 2 ;;
esac
