#!/usr/bin/env python3
"""Local-only fake credential / destination probe for nono 0.79.0."""
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import threading
import argparse
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = None
WORK = None
NONO = None
TOKEN = 'nas-probe-owner-token-not-a-real-secret'
ATTACKER = 'nas-probe-attacker-token-not-a-real-secret'
events = []


class API(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        auth = self.headers.get_all('Authorization', [])
        identity = ('owner' if auth == ['Bearer ' + TOKEN]
                    else 'attacker' if auth == ['Bearer ' + ATTACKER] else 'other')
        event = {'method': self.command, 'path': self.path, 'identity': identity,
                 'authorization_count': len(auth), 'attacker_cookie': ATTACKER in self.headers.get('Cookie', ''), 'body': body}
        events.append(event)
        if self.path == '/redirect':
            self.send_response(307)
            self.send_header('Location', '/repos/attacker/stolen/issues')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        response = json.dumps(event).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def run_fixture():
    WORK.mkdir(exist_ok=True)
    for name in ('config', 'state', 'cache', 'runtime', 'results'):
        (ROOT / name).mkdir(exist_ok=True)
    (ROOT / 'owner-token').write_text(TOKEN)
    (ROOT / 'owner-token').chmod(0o600)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), API)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_port
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
                    '-addext', 'basicConstraints=critical,CA:FALSE', '-keyout', str(ROOT / 'tls.key'),
                    '-out', str(ROOT / 'tls.crt')], check=True, capture_output=True)
    tls_server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), API)
    tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls_context.load_cert_chain(ROOT / 'tls.crt', ROOT / 'tls.key')
    tls_server.socket = tls_context.wrap_socket(tls_server.socket, server_side=True)
    tls_thread = threading.Thread(target=tls_server.serve_forever, daemon=True)
    tls_thread.start()
    base = {
        'meta': {'name': 'nas-nono-fixture-probe', 'version': '1.0.0'},
        'groups': {'exclude': ['system_write_linux']},
        'filesystem': {'read': ['/nix/store'], 'allow': [str(WORK)],
                       'write_file': ['/dev/null']},
        'network': {
            'credentials': ['probe'],
            'custom_credentials': {'probe': {
                'upstream': f'http://127.0.0.1:{port}',
                'credential_key': 'file://' + str(ROOT / 'owner-token'),
                'env_var': 'PROBE_TOKEN',
                'inject_header': 'Authorization', 'credential_format': 'Bearer {}',
                'endpoint_rules': [
                    {'method': 'GET', 'path': '/whoami'},
                    {'method': 'GET', 'path': '/redirect'},
                    {'method': 'POST', 'path': '/repos/trusted/private/issues'},
                ],
            }},
        },
    }
    env = {k: os.environ[k] for k in ('HOME', 'USER', 'PATH') if k in os.environ}
    env.update({
        'XDG_CONFIG_HOME': str(ROOT / 'config'), 'XDG_STATE_HOME': str(ROOT / 'state'),
        'XDG_CACHE_HOME': str(ROOT / 'cache'), 'XDG_RUNTIME_DIR': str(ROOT / 'runtime'),
        'PYTHONDONTWRITEBYTECODE': '1', 'PROBE_FIXTURE_PORT': str(port),
        'PROBE_TLS_PORT': str(tls_server.server_port),
        'SSL_CERT_FILE': str(ROOT / 'tls.crt'),
    })
    results = []
    try:
        for name, graphql in [('credential-only', False), ('graphql-allowed', True), ('broad-domain', False), ('https-origin', False), ('https-origin-graphql', True), ('https-policy', False), ('https-policy-graphql', True), ('command-scoped', False)]:
            profile = json.loads(json.dumps(base))
            if name == 'broad-domain':
                profile['network']['allow_domain'] = ['localhost']
            if graphql:
                profile['network']['custom_credentials']['probe']['endpoint_rules'].append(
                    {'method': 'POST', 'path': '/graphql'})
            if name.startswith('https-'):
                profile['network']['allow_domain'] = ['localhost']
                profile['network']['custom_credentials']['probe'].update({
                    'upstream': f'https://localhost:{tls_server.server_port}',
                    'tls_ca': str(ROOT / 'tls.crt'),
                })
            if name.startswith('https-policy'):
                credential = profile['network']['custom_credentials']['probe']
                credential['endpoint_policy'] = {'default': {'decision': 'deny'}, 'allow': credential.pop('endpoint_rules')}
            if name.startswith('command-scoped'):
                credential = profile.pop('network')['custom_credentials']['probe']
                rules = credential.pop('endpoint_rules')
                credential['type'] = 'proxy'
                profile['command_policies'] = {
                    'credentials': {'probe': credential},
                    'commands': {'python3': {
                        'executable': shutil.which('python3'),
                        'sandbox': {
                            'fs_read': ['/nix/store', str(WORK)],
                            'environment': {'allow_vars': ['PATH', 'HOME', 'USER', 'PROBE_FIXTURE_PORT', 'PROBE_TLS_PORT', 'PYTHONDONTWRITEBYTECODE']},
                            'credentials': [{'name': 'probe', 'endpoint_policy': {'default': 'deny', 'allow': rules}}],
                        },
                    }},
                }
            path = ROOT / (name + '.json')
            path.write_text(json.dumps(profile, indent=2) + '\n')
            start = len(events)
            command = [str(NONO), 'run', '--profile', str(path), '--allow-cwd',
                       '--no-rollback', '--no-diagnostics', '--',
                       'python3' if name.startswith('command-scoped') else shutil.which('python3'), str(WORK / 'client.py')]
            run = subprocess.run(command, cwd=WORK, env=env, capture_output=True,
                                 text=True, timeout=100)
            (ROOT / 'results' / (name + '.stdout')).write_text(run.stdout)
            (ROOT / 'results' / (name + '.stderr')).write_text(run.stderr)
            cases = []
            for line in run.stdout.splitlines():
                try:
                    cases.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
            result = {'profile': name, 'exit': run.returncode, 'cases': cases,
                      'upstream_events': events[start:]}
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        return results
    finally:
        tls_server.shutdown()
        tls_server.server_close()
        tls_thread.join(timeout=5)
        (ROOT / 'tls.key').unlink(missing_ok=True)
        (ROOT / 'tls.crt').unlink(missing_ok=True)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        (ROOT / 'owner-token').unlink(missing_ok=True)


def main():
    global ROOT, WORK, NONO
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nono', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    NONO = args.nono.resolve()
    with tempfile.TemporaryDirectory(prefix='nas-nono-a1b-') as temporary:
        ROOT = Path(temporary)
        WORK = ROOT / 'workspace'
        WORK.mkdir()
        shutil.copyfile(HERE / 'client.py', WORK / 'client.py')
        try:
            results = run_fixture()
        except PermissionError as error:
            print(json.dumps({'environment_error': str(error)}))
            return 2
        report = {
            'version': subprocess.check_output([str(NONO), '--version'], text=True).strip(),
            'platform': os.uname().sysname + ' ' + os.uname().release,
            'profiles': results,
            'stderr': {p.stem: p.read_text().replace(str(ROOT), '<probe-dir>')
                       for p in (ROOT / 'results').glob('*.stderr')},
        }
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
        for result in results:
            if result['profile'] == 'command-scoped':
                continue  # Launch failures are recorded as unverified, never as blocked attacks.
            cases = {case['case']: case for case in result['cases']}
            assert result['exit'] == 0
            assert cases['C0-owner-control']['status'] == 200
            assert cases['C14-after-control']['status'] == 200
            assert cases['C2-attacker-token']['status'] == 401
            assert cases['C7-forbidden-repo']['status'] == 403
            assert cases['C8-forbidden-method']['status'] == 403
            graphql = result['profile'] == 'graphql-allowed' or result['profile'].endswith('-graphql')
            assert cases['C12-graphql-attacker-repo']['status'] == (200 if graphql else 403)
            explicit = result['profile'].startswith('https-policy')
            if explicit:
                denied = cases['C15-forward-tunnel-attacker']
                assert denied.get('status') == 403 or denied.get('error') == 'ConnectionResetError'
                assert not any(event['identity'] == 'attacker' for event in result['upstream_events'])
                assert not any(event['path'] == '/repos/attacker/stolen/issues' for event in result['upstream_events'])
                assert json.loads(cases['C16-forward-allowed-path-attacker']['body'])['identity'] == 'owner'
                assert cases['C17-forward-graphql-attacker']['status'] == (200 if graphql else 403)
            else:
                assert cases['C15-forward-tunnel-attacker']['status'] == 200
                assert any(event['identity'] == 'attacker' and event['body'] == 'synthetic-source-marker'
                           for event in result['upstream_events'])
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
