#!/usr/bin/env python3
"""Test one user-designated token with gh issue create; close only its marked probe issue."""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pass-entry', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--transport', choices=['gh', 'rest', 'direct'], default='gh')
parser.add_argument('--execute', action='store_true')
args = parser.parse_args()
if not args.execute:
    parser.error('--execute is required')
repo = 'Hogeyama/nix-agent-sandbox'
result = subprocess.run(['pass', args.pass_entry], capture_output=True, text=True, timeout=30)
if result.returncode or not result.stdout.strip():
    raise RuntimeError('credential lookup failed; output suppressed')
token = result.stdout.splitlines()[0].strip()
del result
marker = 'nas-readonly-check-' + uuid.uuid4().hex[:12]
title = '[sandbox probe] read-only token check ' + marker
body = 'Authorized token-permission test. Artificial marker only: ' + marker
report = {'source': 'pass ' + args.pass_entry, 'repo': repo, 'marker': marker, 'title': title, 'transport': args.transport,
          'token_kind': 'fine_grained_PAT' if token.startswith('github_pat_') else 'other',
          'cleanup': [], 'errors': []}


def safe(value):
    if token in value:
        raise RuntimeError('credential detected in command output; discarded')
    return value


with tempfile.TemporaryDirectory(prefix='nas-readonly-check-') as temporary:
    root = Path(temporary)
    config = root / 'gh-config'
    config.mkdir()
    environment = {key: os.environ[key] for key in ('HOME', 'USER', 'PATH') if key in os.environ}
    environment.update({'GH_TOKEN': token, 'GH_CONFIG_DIR': str(config), 'GH_HOST': 'github.com',
                        'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1',
                        'GH_NO_EXTENSION_UPDATE_NOTIFIER': '1', 'GH_TELEMETRY': '0', 'DO_NOT_TRACK': '1'})
    lookup = subprocess.run(['gh', 'api', 'repos/' + repo, '--jq', '.full_name'], cwd=root, env=environment,
                            capture_output=True, text=True, timeout=30)
    report['read_control'] = {'exit': lookup.returncode, 'stdout': safe(lookup.stdout.strip()), 'stderr': safe(lookup.stderr.strip())}
    assert lookup.returncode == 0 and lookup.stdout.strip() == repo
    created = None
    try:
        command = ['gh', 'issue', 'create', '--repo', repo, '--title', title, '--body-file', '-']
        request = body
        if args.transport == 'rest':
            command = ['gh', 'api', '--method', 'POST', 'repos/' + repo + '/issues', '--input', '-']
            request = json.dumps({'title': title, 'body': body})
        if args.transport == 'direct':
            # Explicit TLS connection: no gh authentication, proxy environment, or redirect handling.
            connection = http.client.HTTPSConnection('api.github.com', timeout=45)
            try:
                connection.request('POST', '/repos/' + repo + '/issues',
                                   body=json.dumps({'title': title, 'body': body}),
                                   headers={'Authorization': 'Bearer ' + token,
                                            'Accept': 'application/vnd.github+json',
                                            'Content-Type': 'application/json',
                                            'User-Agent': 'nas-authorized-permission-probe',
                                            'X-GitHub-Api-Version': '2022-11-28'})
                response = connection.getresponse()
                report['http_status'] = response.status
                report['response_headers'] = {key: response.getheader(key) for key in
                                              ('X-Accepted-GitHub-Permissions', 'X-GitHub-Request-Id')}
                result = subprocess.CompletedProcess([], 0 if response.status == 201 else 1,
                                                     response.read().decode(), '')
            finally:
                connection.close()
        else:
            result = subprocess.run(command, cwd=root, env=environment, input=request,
                                    capture_output=True, text=True, timeout=45)
        output = safe(result.stdout.strip())
        if args.transport in ('rest', 'direct') and result.returncode == 0:
            response = json.loads(output)
            output = json.dumps({key: response[key] for key in ('html_url', 'number', 'node_id', 'state')})
        report['write_attempt'] = {'exit': result.returncode, 'stdout': output, 'stderr': safe(result.stderr.strip())}
        match = re.search(r'https://github\.com/' + re.escape(repo) + r'/issues/(\d+)', result.stdout)
        if match:
            created = int(match.group(1))
            report['issue'] = {'number': created, 'url': match.group(0)}
    except Exception as error:
        report['errors'].append(safe(type(error).__name__ + ': ' + str(error)))
    finally:
        # Cleanup uses the existing host write credential only after the isolated attempt finishes.
        # The creating gh process never receives or reads that credential.
        if created is not None:
            endpoint = f'repos/{repo}/issues/{created}'
            issue = json.loads(subprocess.check_output(['gh', 'api', endpoint], text=True))
            assert issue['title'] == title and issue['body'] == body
            assert issue['html_url'] == report['issue']['url'] and 'pull_request' not in issue
            issue = json.loads(subprocess.check_output(['gh', 'api', '--method', 'PATCH', endpoint, '--input', '-'],
                                                       input=json.dumps({'state': 'closed'}), text=True))
            assert issue['state'] == 'closed'
            report['cleanup'].append({'number': created, 'url': issue['html_url'], 'state': issue['state']})
        report['unexpected_secret_files'] = [str(path.relative_to(root)) for path in root.rglob('*')
                                            if path.is_file() and token.encode() in path.read_bytes()]
report['gh_version'] = subprocess.check_output(['gh', '--version'], text=True).splitlines()[0]
serialized = safe(json.dumps(report, indent=2, ensure_ascii=False))
args.output.write_text(serialized + '\n')
print(serialized)
assert not report['errors'] and not report['unexpected_secret_files']
