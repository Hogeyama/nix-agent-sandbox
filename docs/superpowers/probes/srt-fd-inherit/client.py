#!/usr/bin/env python3
"""サンドボックス内から、継承した制御用 fd 経由でブローカーに接続できるかを調べる。

    python3 client.py [LABEL]

結果を 1 行の JSON で stdout に書く。SUMI_PROBE_LOG が設定されていれば、
そのファイルにも追記する (hook の stdout は利用者に見えないため)。
"""

import json
import os
import socket
import stat
import sys


def check() -> dict:
    r: dict = {"label": sys.argv[1] if len(sys.argv) > 1 else "direct", "pid": os.getpid()}

    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.close()
        r["socket_af_unix"] = "allowed"
    except OSError as e:
        r["socket_af_unix"] = f"blocked: {e.strerror}"

    try:
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        a.close()
        b.close()
        r["socketpair"] = "allowed"
    except OSError as e:
        r["socketpair"] = f"blocked: {e.strerror}"

    raw = os.environ.get("SUMI_PROBE_FD")
    r["env_fd"] = raw
    if raw is None:
        r["result"] = "FAIL: SUMI_PROBE_FD is not set"
        return r
    fd = int(raw)
    try:
        st = os.fstat(fd)
    except OSError as e:
        r["result"] = f"FAIL: fd {fd} is not open ({e.strerror})"
        return r
    if not stat.S_ISSOCK(st.st_mode):
        r["result"] = f"FAIL: fd {fd} is open but not a socket"
        return r

    ctrl = socket.socket(fileno=os.dup(fd))
    try:
        mine, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        socket.send_fds(ctrl, [b"c"], [theirs.fileno()])
        theirs.close()
        mine.sendall(b"hello")
        mine.shutdown(socket.SHUT_WR)
        reply = b""
        while chunk := mine.recv(4096):
            reply += chunk
        mine.close()
        r["reply"] = reply.decode(errors="replace")
        r["result"] = "PASS" if reply == b"echo:hello" else "FAIL: unexpected reply"
    except OSError as e:
        r["result"] = f"FAIL: {e.strerror}"
    finally:
        ctrl.close()
    return r


def main() -> int:
    line = json.dumps(check())
    print(line)
    log = os.environ.get("SUMI_PROBE_LOG")
    if log:
        with open(log, "a") as f:
            f.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
