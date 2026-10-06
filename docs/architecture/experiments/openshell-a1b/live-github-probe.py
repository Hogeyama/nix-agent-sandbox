#!/usr/bin/env python3
"""User-authorized real GitHub Issue probe; creates at most four marked Issues and closes them."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

BASE = Path(__file__).resolve().parent
p = argparse.ArgumentParser()
p.add_argument('--cli', required=True)
p.add_argument('--work', required=True)
p.add_argument('--output', required=True)
p.add_argument('--port', type=int, default=27770)
a = p.parse_args()
work = Path(a.work).resolve(); work.mkdir(parents=True, exist_ok=True)
if any(work.iterdir()): raise SystemExit('work directory must be empty')
for d in ['state', 'config']: (work/d).mkdir()
run_id = 'nas-live-' + format(time.time_ns(), 'x')[-9:]
gateway = run_id + '-gateway'
cli = str(Path(a.cli).resolve())
image = 'nas-a1b-openshell-client:20261006'
allowed_repo, other_repo = 'Hogeyama/nix-agent-sandbox', 'Hogeyama/test-github'
base_env = {'PATH': os.environ['PATH'], 'XDG_CONFIG_HOME': str(work/'config'), 'OPENSHELL_COLOR': 'never'}
secret = None
created_gateway = False
requests_started = False
metadata = {}
results = {'run_id': run_id, 'observations': {}, 'cleanup_issues': [], 'resources': {}, 'execution_status': 'starting'}
expected = {}


def safe(text):
    if secret and secret in text: raise RuntimeError('credential detected in captured output; suppressed')
    return text


def run(args, *, env=None, input=None, check=True):
    r = subprocess.run(args, env=env, input=input, text=True, capture_output=True)
    # Raw output stays in memory. No subprocess stdout/stderr is printed or persisted.
    safe(r.stdout); safe(r.stderr)
    if check and r.returncode:
        detail = safe(r.stderr[:800]) if args[1] == 'profile' else ''
        raise RuntimeError('command failed: ' + Path(args[0]).name + ' ' + args[1] + ' exit=' + str(r.returncode) + (' ' + detail if detail else ''))
    return r


def oshell(*args, input=None, check=True, extra_env=None):
    env = dict(base_env)
    if extra_env: env.update(extra_env)
    return run([cli, *args], env=env, input=input, check=check)


def gh(endpoint, *, method='GET', data=None):
    env = dict(os.environ)
    if secret: env['GH_TOKEN'] = secret
    args = ['gh', 'api', endpoint, '--method', method]
    if data is not None: args += ['--input', '-']
    r = run(args, env=env, input=json.dumps(data) if data is not None else None)
    return json.loads(r.stdout)


def close_own_issues():
    # GitHub issue lists can lag immediately after createIssue. Use returned numbers first.
    candidates = {}
    for observation in results['observations'].values():
        if 'number' in observation:
            candidates[(observation['repo'], observation['number'])] = observation
    # A listing is only a fallback for an interrupted/lost create response.
    for repo in [allowed_repo, other_repo]:
        issues = gh('repos/' + repo + '/issues?state=all&per_page=100&sort=created&direction=desc')
        for issue in issues:
            marker = expected.get((repo, issue.get('title')))
            if marker is None or (issue.get('body') or '').replace('\r\n', '\n') != marker: continue
            candidates.setdefault((repo, issue['number']), {
                'repo': repo, 'url': issue['html_url'], 'number': issue['number'], 'nodeId': issue['node_id']})
    for (repo, number), observation in candidates.items():
        url = 'https://github.com/' + repo + '/issues/' + str(number)
        current = gh('repos/' + repo + '/issues/' + str(number))
        marker = expected.get((repo, current.get('title')))
        if (marker is None or (current.get('body') or '').replace('\r\n', '\n') != marker
                or current.get('html_url') != url or observation['url'] != url
                or current.get('node_id') != observation['nodeId'] or 'pull_request' in current):
            raise RuntimeError('Issue ownership check failed; no mutation')
        if current['state'] != 'closed':
            current = gh('repos/' + repo + '/issues/' + str(number), method='PATCH',
                         data={'state': 'closed', 'state_reason': 'completed'})
        if current['state'] != 'closed': raise RuntimeError('Issue close was not confirmed')
        results['cleanup_issues'].append({'repo': repo, 'url': url, 'number': number,
                                         'nodeId': current['node_id'], 'status': current['state']})
    known = {(r['repo'], r['number']) for r in results['observations'].values() if 'number' in r}
    closed = {(r['repo'], r['number']) for r in results['cleanup_issues']}
    if not known.issubset(closed): raise RuntimeError('Created Issue cleanup was incomplete')

try:
    # Refuse before reading credentials when Docker is inaccessible in the outer sandbox.
    run(['docker', 'info', '--format', '{{.ServerVersion}}'])
    credential_result = subprocess.run(['gh', 'auth', 'token'], text=True, capture_output=True)
    if credential_result.returncode: raise RuntimeError('gh auth token failed; output suppressed')
    secret = credential_result.stdout.strip()
    del credential_result
    if not secret: raise RuntimeError('empty GitHub credential')
    for repo in [allowed_repo, other_repo]:
        data = gh('repos/' + repo)
        if not data['has_issues'] or not data.get('permissions', {}).get('push'): raise RuntimeError('repository is not ready for authorized Issue probe')
        metadata[repo] = data['node_id']
    results['metadata'] = [{'repo': repo, 'nodeId': node, 'status': 'issues_enabled_push_allowed'} for repo, node in metadata.items()]
    endpoints = '''  - host: api.github.com
    port: 443
    protocol: rest
    enforcement: enforce
    rules:
      - allow: { method: POST, path: /repos/Hogeyama/nix-agent-sandbox/issues }
  - host: api.github.com
    port: 443
    path: /graphql
    protocol: graphql
    enforcement: enforce
    rules:
      - allow: { operation_type: mutation, fields: [createIssue] }
'''
    (work/'profile.yaml').write_text('''id: nas-live-github
display_name: NAS authorized live GitHub probe
description: User-authorized recipient restriction verification
category: source_control
credentials:
  - name: api_token
    env_vars: [NAS_GITHUB_PROBE_TOKEN]
    required: true
    auth_style: bearer
    header_name: authorization
endpoints:
''' + endpoints + "binaries: ['/usr/bin/python*']\n")
    (work/'policy.yaml').write_text('''version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/bin, /usr, /lib, /lib64, /proc, /dev/urandom, /app, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null]
landlock:
  compatibility: best_effort
network_policies: {}
''')
    run(['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '-v', f'{work}:{work}',
         'ghcr.io/nvidia/openshell/gateway:0.1.2', 'generate-certs', '--output-dir', str(work/'tls'), '--server-san', 'host.openshell.internal'])
    (work/'gateway.toml').write_text(f'''[openshell]
version = 2
[openshell.gateway]
bind_address = "127.0.0.1:{a.port}"
health_bind_address = "127.0.0.1:{a.port+1}"
log_level = "info"
compute_driver = "docker"
disable_tls = false
[openshell.drivers.docker]
default_image = "ubuntu:24.04"
sandbox_runtime_image = "ghcr.io/nvidia/openshell/sandbox:0.1.2"
supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.1.2"
image_pull_policy = "if_not_present"
sandbox_label = "{run_id}"
grpc_endpoint = "https://127.0.0.1:{a.port}"
app_armor_profile = "Unconfined"
''')
    run(['docker', 'run', '-d', '--name', gateway, '--network', 'host', '--user', '0',
         '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', f'{work}:{work}',
         '-e', f'OPENSHELL_LOCAL_TLS_DIR={work}/tls', '-e', f'XDG_DATA_HOME={work}/state',
         '-e', f'OPENSHELL_DB_URL=sqlite:{work}/state/gateway.db?mode=rwc', '-e', 'OPENSHELL_TELEMETRY_ENABLED=false',
         'ghcr.io/nvidia/openshell/gateway:0.1.2', '--config', str(work/'gateway.toml')])
    created_gateway = True
    mtls = work/'config'/'openshell'/'gateways'/run_id/'mtls'; mtls.mkdir(parents=True)
    for f in ['ca.crt', 'client/tls.crt', 'client/tls.key']: shutil.copyfile(work/'tls'/f, mtls/Path(f).name)
    for _ in range(40):
        if oshell('gateway', 'add', f'https://127.0.0.1:{a.port}', '--local', '--name', run_id, check=False).returncode == 0: break
        time.sleep(1)
    else: raise RuntimeError('gateway registration timeout')
    for _ in range(60):
        if oshell('status', check=False).returncode == 0: break
        time.sleep(.5)
    else: raise RuntimeError('gateway readiness timeout')
    oshell('profile', 'import', '-f', str(work/'profile.yaml'))
    oshell('provider', 'create', '--name', 'nas-live-credential', '--type', 'nas-live-github',
           '--credential', 'NAS_GITHUB_PROBE_TOKEN', extra_env={'NAS_GITHUB_PROBE_TOKEN': secret})
    oshell('sandbox', 'create', '--name', run_id, '--from', image, '--policy', str(work/'policy.yaml'),
           '--provider', 'nas-live-credential', '--no-auto-providers', '--no-tty', '--detach', '--', 'sleep', 'infinity')
    client = (BASE/'live-github-client.py').read_text()
    for case, transport, repo in [('rest_allowed', 'REST', allowed_repo), ('rest_other', 'REST', other_repo),
                                 ('graphql_allowed', 'GraphQL', allowed_repo), ('graphql_other', 'GraphQL', other_repo)]:
        title = '[sandbox probe] OpenShell ' + case + ' ' + run_id
        body = 'Artificial marker: ' + run_id + '/' + case + '\nAuthorized sandbox recipient-policy verification only. No project data.'
        expected[(repo, title)] = body
        spec = {'repo': repo, 'repo_id': metadata[repo], 'title': title, 'body': body, 'transport': transport}
        requests_started = True
        # Script enters through -c, request data through stdin. Neither contains credentials.
        r = oshell('sandbox', 'exec', '--name', run_id, '--no-tty', '--no-login-shell', '--', 'python3', '-c', client,
                   input=json.dumps(spec)+'\n', check=False)
        safe(r.stdout)
        try: observation = json.loads(r.stdout)
        except ValueError: raise RuntimeError('sandbox result was not a filtered JSON record')
        if set(observation) - {'repo', 'url', 'number', 'nodeId', 'status'}: raise RuntimeError('unexpected result fields')
        results['observations'][case] = observation
        if case == 'rest_allowed' and observation.get('status') != 'open': raise RuntimeError('normal REST control failed; stop further writes')
    results['execution_status'] = 'completed'
except Exception as error:
    # Only our deliberately sanitized exception text is emitted.
    results['execution_status'] = 'failed'
    results['failure'] = safe(str(error))
finally:
    if requests_started:
        try: close_own_issues()
        except Exception as error: results['issue_cleanup_error'] = safe(str(error))
    if created_gateway:
        oshell('sandbox', 'delete', run_id, check=False)
        selector = 'label=openshell.ai/sandbox-namespace=' + run_id
        for _ in range(20):
            ids = run(['docker', 'ps', '-aq', '--filter', selector], check=False).stdout.split()
            if not ids: break
            time.sleep(.25)
        if ids: run(['docker', 'rm', '-f', *ids], check=False)
        run(['docker', 'rm', '-f', gateway], check=False)
        for kind in ['network', 'volume']:
            ids = run(['docker', kind, 'ls', '-q', '--filter', selector], check=False).stdout.split()
            if ids: run(['docker', kind, 'rm', *ids], check=False)
            results['resources'][kind] = run(['docker', kind, 'ls', '-q', '--filter', selector], check=False).stdout.split()
        results['resources']['containers'] = run(['docker', 'ps', '-aq', '--filter', selector], check=False).stdout.split()
        run(['docker', 'run', '--rm', '--user', '0', '-v', f'{work}:{work}', image, 'python3', '-c',
             'import shutil,sys; [shutil.rmtree(p,ignore_errors=True) for p in sys.argv[1:]]',
             str(work/'tls'), str(work/'config'), str(work/'state')], check=False)
    else:
        results['resources']['created'] = False
    encoded = safe(json.dumps(results, indent=2) + '\n')
    # Check the output before saving; credentials, full API responses and raw process logs are never persisted.
    Path(a.output).write_text(encoded)
    secret = None
    print(encoded, end='')
if results['execution_status'] != 'completed' or results.get('issue_cleanup_error'): raise SystemExit(1)
