#!/usr/bin/env python3
"""Local fake-token tests of nono's REST policy and alternate network paths."""
import argparse
import contextlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading

HERE = Path(__file__).resolve().parent
TOKEN = 'nas-fake-managed-token'
ATTACKER = 'nas-fake-attacker-token'
EVENTS = []
PORTS = {}


class API(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        auth = self.headers.get('Authorization', '')
        record = {'port': self.server.server_port, 'method': self.command, 'path': self.path,
                  'case': self.headers.get('X-Probe-Case'), 'host': self.headers.get('Host'),
                  'identity': 'managed' if auth == 'Bearer ' + TOKEN else 'attacker' if auth == 'Bearer ' + ATTACKER else 'other',
                  'body': self.rfile.read(int(self.headers.get('Content-Length', 0))).decode(errors='replace')}
        EVENTS.append(record)
        redirects = {'/redirect-same': '/repos/attacker/stolen/issues',
                     '/redirect-other-port': f'https://localhost:{PORTS["tls_alt"]}/repos/attacker/stolen/issues',
                     '/redirect-other-host': f'https://127.0.0.1:{PORTS["tls_alt"]}/repos/attacker/stolen/issues'}
        if self.path in redirects:
            self.send_response(307)
            self.send_header('Location', redirects[self.path])
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        body = json.dumps(record).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Raw(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(4)
        received = self.request.recv(2048)
        EVENTS.append({'port': self.server.server_address[1], 'raw': received.decode(errors='replace')})
        self.request.sendall(b'SSH-2.0-local-test-fixture\r\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nono', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    report = {'version': subprocess.check_output([str(args.nono), '--version'], text=True).strip(),
              'profiles': [], 'host_controls': [], 'environment_errors': []}
    with tempfile.TemporaryDirectory(prefix='nas-nono-network-') as temporary, contextlib.ExitStack() as stack:
        root = Path(temporary)
        work = root / 'workspace'
        work.mkdir()
        shutil.copyfile(HERE / 'network-bypass-client.py', work / 'client.py')
        (root / 'owner-token').write_text(TOKEN)
        (root / 'owner-token').chmod(0o600)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
                        '-addext', 'basicConstraints=critical,CA:FALSE', '-keyout', str(root / 'tls.key'),
                        '-out', str(root / 'tls.crt')], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root / 'tls.crt', root / 'tls.key')
        try:
            for name in ('http', 'tls', 'tls_alt', 'tcp'):
                server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Raw) if name == 'tcp' else http.server.ThreadingHTTPServer(('127.0.0.1', 0), API)
                server.daemon_threads = True
                stack.callback(server.server_close)
                if name.startswith('tls'):
                    server.socket = context.wrap_socket(server.socket, server_side=True)
                PORTS[name] = server.server_address[1]
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                stack.callback(thread.join, 3)
                stack.callback(server.shutdown)
        except PermissionError as error:
            report['environment_errors'].append(type(error).__name__ + ': listener denied')
            args.output.write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps(report))
            return 2
        # Positive host controls prove every HTTP fixture accepts the forbidden path.
        for name in ('http', 'tls', 'tls_alt'):
            connection = (http.client.HTTPConnection('localhost', PORTS[name], timeout=4) if name == 'http'
                          else http.client.HTTPSConnection('localhost', PORTS[name], context=ssl._create_unverified_context(), timeout=4))
            connection.request('POST', '/repos/attacker/stolen/issues', body='synthetic-host-control', headers={'Authorization': 'Bearer ' + ATTACKER})
            response = connection.getresponse()
            response.read()
            report['host_controls'].append({'fixture': name, 'status': response.status})
            connection.close()
            assert response.status == 200
        with socket.create_connection(('127.0.0.1', PORTS['tcp']), timeout=4) as connection:
            connection.sendall(b'SSH-2.0-host-positive-control\r\n')
            assert connection.recv(256).startswith(b'SSH-2.0-local-test-fixture')
        report['host_controls'].append({'fixture': 'tcp', 'ssh_banner': True})
        report['ports'] = PORTS
        for profile_name in ('host-allow', 'port-allow', 'unrelated-allow', 'known-ports-denied'):
            state = root / profile_name
            state.mkdir()
            env = {key: os.environ[key] for key in ('HOME', 'USER', 'PATH') if key in os.environ}
            for key, name in [('XDG_CONFIG_HOME', 'config'), ('XDG_STATE_HOME', 'state'), ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime')]:
                (state / name).mkdir()
                env[key] = str(state / name)
            env.update({'PYTHONDONTWRITEBYTECODE': '1', 'PROBE_PORTS': json.dumps(PORTS),
                        'PROBE_CURL': shutil.which('curl'), 'SSL_CERT_FILE': str(root / 'tls.crt')})
            allowed = {'host-allow': ['localhost'], 'port-allow': [f'localhost:{PORTS["tls"]}'],
                       'unrelated-allow': ['unused.invalid'], 'known-ports-denied': ['unused.invalid']}[profile_name]
            profile = {'meta': {'name': 'nas-nono-network', 'version': '1.0.0'},
                       'groups': {'exclude': ['system_write_linux']},
                       'filesystem': {'read': ['/nix/store'], 'allow': [str(work)], 'write_file': ['/dev/null']},
                       'network': {'allow_domain': allowed, 'credentials': ['probe'], 'custom_credentials': {'probe': {
                           'upstream': f'https://localhost:{PORTS["tls"]}', 'credential_key': 'file://' + str(root / 'owner-token'),
                           'env_var': 'PROBE_TOKEN', 'inject_header': 'Authorization', 'credential_format': 'Bearer {}',
                           'tls_ca': str(root / 'tls.crt'),
                           'endpoint_policy': {'default': {'decision': 'deny'}, 'allow': [
                               {'method': 'GET', 'path': path} for path in
                               ['/repos/trusted/private/pulls', '/redirect-same', '/redirect-other-port', '/redirect-other-host']]}}}}}
            if profile_name == 'known-ports-denied':
                profile['network']['deny_domain'] = [f'localhost:{PORTS[name]}' for name in ('http', 'tls_alt', 'tcp')]
            config = state / 'profile.json'
            config.write_text(json.dumps(profile))
            start = len(EVENTS)
            result = subprocess.run([str(args.nono.resolve()), 'run', '--profile', str(config), '--allow-cwd',
                                     '--no-rollback', '--no-diagnostics', '--', shutil.which('python3'), str(work / 'client.py')],
                                    cwd=work, env=env, capture_output=True, text=True, timeout=130)
            cases = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            record = {'profile': profile_name, 'exit': result.returncode, 'cases': cases,
                      'events': EVENTS[start:], 'stderr': result.stderr.replace(temporary, '<probe-dir>')}
            report['profiles'].append(record)
            args.output.write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps({'profile': profile_name, 'exit': result.returncode, 'cases': len(cases), 'events': len(record['events'])}), flush=True)
            assert result.returncode == 0 and len(cases) == 26
            by_name = {case['case']: case for case in cases}
            assert by_name['B00-reverse-control']['status'] == 200
            assert by_name['B01-connect-control']['status'] == 200
            assert by_name['B25-final-control']['status'] == 200
            for case in ('B02-forbidden-repo', 'B03-forbidden-method', 'B04-graphql', 'B15-trailing-dot',
                         'B16-uppercase', 'B21-encoded-path', 'B22-dot-path'):
                assert by_name[case]['status'] == 403
                assert not any(event.get('case') == case for event in record['events'])
            for case in ('B05-direct-host', 'B06-direct-ip'):
                assert by_name[case]['error'] == 'PermissionError'
            assert not any(event.get('case') == 'B07-curl-noproxy' for event in record['events'])
            assert by_name['B08-socks5'].get('error') == 'TimeoutError'
            assert 'HTTP_STATUS:403' in by_name['B18-redirect-same']['stdout']
            assert 'HTTP_STATUS:403' in by_name['B24-http2']['stdout']
            # The default proxy does not negotiate HTTP/2; the curl request falls back.
            assert 'HTTP_VERSION:1.1' in by_name['B24-http2']['stdout']
            assert by_name['B09-plain-forward']['status'] == (403 if profile_name == 'known-ports-denied' else 200)
            other_tls = by_name['B13-other-tls-port']
            if profile_name == 'known-ports-denied':
                assert other_tls.get('error') == 'OSError' and '403' in other_tls.get('detail', '')
            else:
                assert other_tls['status'] == 200
            for case in ('B10-plain-connect', 'B11-ssh-other-port'):
                assert (' 403 ' if profile_name == 'known-ports-denied' else ' 200 ') in by_name[case]['outer']
            assert ('HTTP_STATUS:000' if profile_name == 'known-ports-denied' else 'HTTP_STATUS:200') in by_name['B19-redirect-other-port']['stdout']
        report['ports'] = PORTS
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
