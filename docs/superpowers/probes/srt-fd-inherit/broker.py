#!/usr/bin/env python3
"""制御用 fd を継承させて COMMAND を起動し、届いた接続をエコーで返すブローカー。

    python3 broker.py -- COMMAND [ARGS...]

SOCK_SEQPACKET の socketpair を作り、片方を CLOEXEC なしで子に渡す。
番号は環境変数 SUMI_PROBE_FD で伝える。クライアントは自分で作った
socketpair の片方を SCM_RIGHTS でこの fd に送り、残りでストリームを話す。
ブローカーは受け取った接続から EOF まで読み、`echo:` を前置して返す。
"""

import os
import socket
import subprocess
import sys
import threading


def serve_conn(conn: socket.socket, n: int) -> None:
    with conn:
        data = b""
        while chunk := conn.recv(4096):
            data += chunk
        conn.sendall(b"echo:" + data)
    print(f"broker: connection {n} echoed {len(data)} bytes", file=sys.stderr)


def accept_loop(ctrl: socket.socket) -> None:
    n = 0
    while True:
        try:
            msg, fds, _flags, _addr = socket.recv_fds(ctrl, 16, 4)
        except OSError:
            return
        if not msg and not fds:
            return
        for fd in fds:
            n += 1
            conn = socket.socket(fileno=fd)
            threading.Thread(target=serve_conn, args=(conn, n), daemon=True).start()


def main() -> int:
    argv = sys.argv[1:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        print("usage: broker.py -- COMMAND [ARGS...]", file=sys.stderr)
        return 2

    ours, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    theirs.set_inheritable(True)
    env = dict(os.environ, SUMI_PROBE_FD=str(theirs.fileno()))
    threading.Thread(target=accept_loop, args=(ours,), daemon=True).start()

    child = subprocess.Popen(argv, env=env, pass_fds=(theirs.fileno(),))
    theirs.close()
    return child.wait()


if __name__ == "__main__":
    sys.exit(main())
