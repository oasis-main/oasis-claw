#!/usr/bin/env python3
"""modal_relay — let the Modal client inside Yes Man reach api.modal.com (CLAW-116).

The Modal client (modal/_utils/grpc_utils.py create_channel) opens a direct
grpclib connection and never reads HTTPS_PROXY, so a sandboxed bot cannot reach
Modal through the egress proxy. In Yes Man, compose maps api.modal.com to
127.0.0.1 (extra_hosts) and the `modal` wrapper sets
MODAL_SERVER_URL=https://api.modal.com:8443. This relay listens on
127.0.0.1:8443 and, per connection, opens an HTTP CONNECT tunnel for
api.modal.com:443 through the egress proxy, then copies bytes both ways.

- TLS stays end to end between the client and Modal: the client still checks
  Modal's certificate for api.modal.com. The relay never sees plaintext.
- The destination is fixed. The relay cannot be pointed at another host, and
  the egress proxy still decides whether api.modal.com is allowed for this bot.
- Standard library only. Staged read-only at /opt/infra-tools/lib by
  scripts/claw-infra-tools; the wrapper starts it on demand with --ensure.

Known limit: Modal uploads large files (about 4 MB and up) to blob storage over
aiohttp without proxy support, so those uploads still fail.
"""

import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

LISTEN = ("127.0.0.1", int(os.environ.get("MODAL_RELAY_PORT", "8443")))
TARGET = "api.modal.com:443"


def proxy_addr():
    url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "http://egress-proxy:3128"
    u = urllib.parse.urlparse(url)
    return u.hostname, u.port or 3128


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(client):
    upstream = None
    try:
        upstream = socket.create_connection(proxy_addr(), timeout=20)
        upstream.sendall(f"CONNECT {TARGET} HTTP/1.1\r\nHost: {TARGET}\r\n\r\n".encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = upstream.recv(4096)
            if not chunk:
                raise OSError("proxy closed the connection")
            head += chunk
            if len(head) > 16384:
                raise OSError("proxy response too long")
        status = head.split(b"\r\n", 1)[0]
        if b" 200" not in status:
            sys.stderr.write(f"modal_relay: proxy refused CONNECT {TARGET}: {status.decode(errors='replace')}\n")
            client.close()
            upstream.close()
            return
        rest = head.split(b"\r\n\r\n", 1)[1]
        if rest:
            client.sendall(rest)
        upstream.settimeout(None)
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        pump(upstream, client)
    except OSError as e:
        sys.stderr.write(f"modal_relay: {e}\n")
        for s in (client, upstream):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass


def listening():
    try:
        socket.create_connection(LISTEN, timeout=0.5).close()
        return True
    except OSError:
        return False


def serve():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(64)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


def ensure():
    """Start the relay in its own session if nothing listens yet."""
    if listening():
        return 0
    log = open("/tmp/modal-relay.log", "ab")
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--serve"],
                     stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     start_new_session=True)
    for _ in range(30):
        if listening():
            return 0
        time.sleep(0.1)
    sys.stderr.write("modal_relay: did not start; see /tmp/modal-relay.log\n")
    return 1


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
    elif "--ensure" in sys.argv:
        sys.exit(ensure())
    else:
        print(__doc__)
