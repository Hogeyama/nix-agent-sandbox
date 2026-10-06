#!/usr/bin/env python3
"""Retry the authorized Issue probe using only pass tmp, including cleanup."""
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

destination = Path(__file__).with_name('tmp-token-after-secret-removal.json')
repo = 'Hogeyama/nix-agent-sandbox'
lookup = subprocess.run(['pass', 'tmp'], capture_output=True, text=True, timeout=30)
if lookup.returncode or not lookup.stdout.strip():
    raise RuntimeError('pass tmp lookup failed; credential output suppressed')
token = lookup.stdout.splitlines()[0].strip()
del lookup
report = {'source': 'pass tmp', 'repo': repo, 'cases': [], 'errors': [],
          'cleanup_credential': 'same pass tmp token; no host credential fallback'}


def save():
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    assert token not in serialized, 'credential detected; output suppressed'
    destination.write_text(serialized + '\n')


def api(method, endpoint, body=None):
    connection = http.client.HTTPSConnection('api.github.com', timeout=45)
    try:
        connection.request(method, endpoint, body=json.dumps(body) if body is not None else None,
                           headers={'Authorization': 'Bearer ' + token,
                                    'User-Agent': 'nas-authorized-permission-probe',
                                    'Accept': 'application/vnd.github+json',
                                    'Content-Type': 'application/json',
                                    'X-GitHub-Api-Version': '2022-11-28'})
        response = connection.getresponse()
        return response.status, json.loads(response.read()), {
            name: response.getheader(name) for name in
            ('X-Accepted-GitHub-Permissions', 'X-GitHub-Request-Id')}
    finally:
        connection.close()


with tempfile.TemporaryDirectory(prefix='nas-token-retry-') as temporary:
    environment = {key: os.environ[key] for key in ('HOME', 'USER', 'PATH') if key in os.environ}
    environment.update({'GH_CONFIG_DIR': temporary, 'GH_HOST': 'github.com',
                        'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1'})
    baseline = subprocess.run(['gh', 'auth', 'token'], env=environment, cwd=temporary,
                              capture_output=True, text=True, timeout=30)
    report['empty_config_without_GH_TOKEN'] = {
        'exit': baseline.returncode, 'credential_returned': bool(baseline.stdout.strip())}
    del baseline
    environment['GH_TOKEN'] = token
    selected = subprocess.run(['gh', 'auth', 'token'], env=environment, cwd=temporary,
                              capture_output=True, text=True, timeout=30)
    report['explicit_GH_TOKEN_matches_pass_tmp'] = selected.returncode == 0 and selected.stdout.strip() == token
    del selected
    assert report['explicit_GH_TOKEN_matches_pass_tmp']
    status, identity, _ = api('GET', '/user')
    report['direct_auth_control'] = {'status': status, 'login': identity.get('login')}
    assert status == 200
    save()
    for transport in ('direct', 'gh'):
        marker = 'nas-secret-removal-' + uuid.uuid4().hex[:12]
        title = '[sandbox probe] token retry ' + marker
        body = 'Authorized token-permission test. Artificial marker only: ' + marker
        case = {'transport': transport, 'marker': marker}
        report['cases'].append(case)
        try:
            number = None
            if transport == 'direct':
                status, response, headers = api('POST', '/repos/' + repo + '/issues', {'title': title, 'body': body})
                case.update({'status': status, 'response_headers': headers})
                if status == 201:
                    number = response['number']
                else:
                    case['message'] = response.get('message')
            else:
                result = subprocess.run(['gh', 'issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'],
                                        input=body, env=environment, cwd=temporary,
                                        capture_output=True, text=True, timeout=45)
                case.update({'exit': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()})
                match = re.search(r'https://github\.com/' + re.escape(repo) + r'/issues/(\d+)', result.stdout)
                if match:
                    number = int(match.group(1))
            if number is not None:
                case['issue_url'] = f'https://github.com/{repo}/issues/{number}'
                save()
                endpoint = f'/repos/{repo}/issues/{number}'
                status, issue, _ = api('GET', endpoint)
                assert status == 200 and issue['title'] == title and issue['body'] == body
                assert issue['html_url'] == case['issue_url'] and 'pull_request' not in issue
                status, issue, _ = api('PATCH', endpoint, {'state': 'closed'})
                case['cleanup'] = {'status': status, 'state': issue.get('state'), 'message': issue.get('message')}
                save()
                if status != 200 or issue.get('state') != 'closed':
                    report['errors'].append('Cleanup failed; stopped before another creation attempt')
                    break
        except Exception as error:
            report['errors'].append(type(error).__name__)
            break
        finally:
            save()
    report['unexpected_secret_files'] = [str(path.relative_to(temporary)) for path in Path(temporary).rglob('*')
                                        if path.is_file() and token.encode() in path.read_bytes()]
save()
print(destination.read_text())
assert not report['errors'] and not report['unexpected_secret_files']
