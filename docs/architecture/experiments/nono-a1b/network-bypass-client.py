"""Adversarial clients for the disposable local nono network fixture."""
import base64
import http.client
import json
import os
import socket
import ssl
import subprocess
import time
import urllib.parse

ATTACKER = 'nas-fake-attacker-token'
PORTS = json.loads(os.environ['PROBE_PORTS'])
BASE = urllib.parse.urlsplit(os.environ['PROBE_BASE_URL'])
PROXY = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
assert PROXY.hostname == BASE.hostname == '127.0.0.1' and PROXY.port == BASE.port
PROXY_AUTH = 'Basic ' + base64.b64encode((urllib.parse.unquote(PROXY.username or '') + ':' + urllib.parse.unquote(PROXY.password or '')).encode()).decode()
FORBIDDEN = '/repos/attacker/stolen/issues'
ALLOWED = '/repos/trusted/private/pulls'
TLS = ssl._create_unverified_context()  # Only the disposable loopback fixture.


def response(connection):
    result = connection.getresponse()
    return {'status': result.status, 'body': result.read().decode(errors='replace')[:1200]}


def request(case, path=ALLOWED, method='GET', host='localhost', port=None, reverse=False, direct=False, headers=None):
    port = PORTS['tls'] if port is None else port
    if reverse:
        connection = http.client.HTTPConnection(BASE.hostname, BASE.port, timeout=3)
        path = BASE.path.rstrip('/') + path
    elif direct:
        connection = http.client.HTTPSConnection(host, port, context=TLS, timeout=3)
    else:
        connection = http.client.HTTPSConnection(PROXY.hostname, PROXY.port, context=TLS, timeout=3)
        connection.set_tunnel(host, port, headers={'Proxy-Authorization': PROXY_AUTH})
    try:
        merged = {'Authorization': 'Bearer ' + (os.environ['PROBE_TOKEN'] if reverse else ATTACKER), 'X-Probe-Case': case}
        merged.update(headers or {})
        connection.request(method, path, body=('synthetic-' + case) if method != 'GET' else None, headers=merged)
        return response(connection)
    finally:
        connection.close()


def raw_tunnel(host, port):
    connection = socket.create_connection((PROXY.hostname, PROXY.port), timeout=3)
    connection.sendall((f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: {PROXY_AUTH}\r\n\r\n').encode())
    received = b''
    while b'\r\n\r\n' not in received:
        piece = connection.recv(1)
        if not piece:
            break
        received += piece
    return connection, received.decode(errors='replace')


def tunnel_payload(case, port, payload):
    connection, outer = raw_tunnel('localhost', port)
    try:
        if ' 200 ' not in outer:
            return {'outer': outer.strip()}
        connection.sendall(payload)
        connection.shutdown(socket.SHUT_WR)
        return {'outer': outer.strip(), 'reply': connection.recv(2048).decode(errors='replace')}
    finally:
        connection.close()


def forward_http(case):
    connection = http.client.HTTPConnection(PROXY.hostname, PROXY.port, timeout=3)
    try:
        connection.request('POST', f'http://localhost:{PORTS["http"]}{FORBIDDEN}',
                           body='synthetic-' + case, headers={'Proxy-Authorization': PROXY_AUTH,
                           'Authorization': 'Bearer ' + ATTACKER, 'X-Probe-Case': case})
        return response(connection)
    finally:
        connection.close()


def socks(case):
    connection = socket.create_connection((PROXY.hostname, PROXY.port), timeout=2)
    try:
        connection.sendall(b'\x05\x01\x00')
        # A SOCKS server must reply before any CONNECT request is sent.
        return {'greeting_reply_hex': connection.recv(2).hex()}
    finally:
        connection.close()


def curl(case, path=ALLOWED, extra=()):
    result = subprocess.run([os.environ['PROBE_CURL'], '--silent', '--show-error', '--insecure',
                             '--max-time', '5', '--proxy', os.environ['HTTPS_PROXY'], '--noproxy', '',
                             '--header', 'Authorization: Bearer ' + ATTACKER,
                             '--header', 'X-Probe-Case: ' + case,
                             '--write-out', '\nHTTP_STATUS:%{http_code}\nHTTP_VERSION:%{http_version}', *extra,
                             f'https://localhost:{PORTS["tls"]}{path}'],
                            capture_output=True, text=True, timeout=7)
    return {'exit': result.returncode, 'stdout': result.stdout[-1800:], 'stderr': result.stderr[-800:]}


def probe(case, function):
    time.sleep(0.35)
    try:
        data = function(case)
    except Exception as error:
        data = {'error': type(error).__name__, 'detail': str(error)}
    serialized = json.dumps({'case': case, **data})
    for value in (os.environ['PROBE_TOKEN'], os.environ['HTTPS_PROXY'], PROXY_AUTH):
        serialized = serialized.replace(value, '<session-value>')
    print(serialized, flush=True)


probe('B00-reverse-control', lambda c: request(c, reverse=True))
probe('B01-connect-control', lambda c: request(c))
probe('B02-forbidden-repo', lambda c: request(c, path=FORBIDDEN, method='POST'))
probe('B03-forbidden-method', lambda c: request(c, method='POST'))
probe('B04-graphql', lambda c: request(c, path='/graphql', method='POST'))
probe('B05-direct-host', lambda c: request(c, direct=True))
probe('B06-direct-ip', lambda c: request(c, direct=True, host='127.0.0.1'))
probe('B07-curl-noproxy', lambda c: curl(c, FORBIDDEN, ('--noproxy', '*', '--data', 'synthetic-' + c)))
probe('B08-socks5', socks)
probe('B09-plain-forward', forward_http)
probe('B10-plain-connect', lambda c: tunnel_payload(c, PORTS['http'],
    (f'POST {FORBIDDEN} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {ATTACKER}\r\nX-Probe-Case: {c}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n').encode()))
probe('B11-ssh-other-port', lambda c: tunnel_payload(c, PORTS['tcp'], ('SSH-2.0-synthetic-' + c + '\r\n').encode()))
probe('B12-ssh-protected-port', lambda c: tunnel_payload(c, PORTS['tls'], ('SSH-2.0-synthetic-' + c + '\r\n').encode()))
probe('B13-other-tls-port', lambda c: request(c, port=PORTS['tls_alt'], path=FORBIDDEN, method='POST'))
probe('B14-connect-ip', lambda c: request(c, host='127.0.0.1', path=FORBIDDEN, method='POST'))
probe('B15-trailing-dot', lambda c: request(c, host='localhost.', path=FORBIDDEN, method='POST'))
probe('B16-uppercase', lambda c: request(c, host='LOCALHOST', path=FORBIDDEN, method='POST'))
probe('B17-inner-host', lambda c: request(c, headers={'Host': f'127.0.0.1:{PORTS["tls_alt"]}'}))
probe('B18-redirect-same', lambda c: curl(c, '/redirect-same', ('--location',)))
probe('B19-redirect-other-port', lambda c: curl(c, '/redirect-other-port', ('--location',)))
probe('B20-redirect-other-host', lambda c: curl(c, '/redirect-other-host', ('--location',)))
probe('B21-encoded-path', lambda c: request(c, path='/repos/trusted/private/%2e%2e/%2e%2e/attacker/stolen/issues', method='POST'))
probe('B22-dot-path', lambda c: request(c, path='/repos/trusted/private/../../attacker/stolen/issues', method='POST'))
probe('B23-query', lambda c: request(c, path=ALLOWED + '?state=open&per_page=30'))
probe('B24-http2', lambda c: curl(c, FORBIDDEN, ('--http2', '--data', 'synthetic-' + c)))
probe('B25-final-control', lambda c: request(c))
