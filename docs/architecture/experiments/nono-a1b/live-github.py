#!/usr/bin/env python3
"""Authorized live GitHub write probe; creates and closes only uniquely marked test issues."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
ALLOWED = 'Hogeyama/nix-agent-sandbox'
FORBIDDEN = 'Hogeyama/test-github'
QUERY = '''mutation Probe($repositoryId:ID!,$title:String!,$body:String!) {
  createIssue(input:{repositoryId:$repositoryId,title:$title,body:$body}) {
    issue { id number url }
  }
}'''


def gh_json(endpoint, method='GET', payload=None):
    command = ['gh', 'api', '--method', method, endpoint]
    if payload is not None:
        command += ['--input', '-']
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                            capture_output=True, text=True, timeout=40)
    if result.returncode:
        raise RuntimeError(f'GitHub API {method} {endpoint} failed (exit {result.returncode})')
    return json.loads(result.stdout)


def verify_report(report):
    cases = {case['case']: case for profile in report['profiles'] for case in profile['cases']}
    assert not report['errors'] and not report['unexpected_secret_files']
    assert cases['rest-allowed']['status'] == 201 and cases['rest-allowed'].get('issue')
    for name in ('rest-forbidden', 'graphql-disabled'):
        assert not cases[name].get('issue')
        assert cases[name].get('status') == 403 or cases[name].get('error') == 'ConnectionResetError'
    for name in ('graphql-allowed', 'graphql-forbidden'):
        assert cases[name]['status'] == 200 and cases[name].get('issue') and not cases[name].get('graphql_errors')
    assert len(report['cleanup']) == 3 and all(issue['state'] == 'closed' for issue in report['cleanup'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nono', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verify-result', type=Path, help='Read-only: verify an existing result and its closed GitHub issues')
    parser.add_argument('--execute', action='store_true', help='Create uniquely marked test issues in the two fixed repositories')
    args = parser.parse_args()
    if args.verify_result:
        report = json.loads(args.verify_result.read_text())
        verify_report(report)
        expected_body = 'Authorized sandbox destination-control test. Synthetic marker only: ' + report['marker']
        for issue in report['cleanup']:
            assert issue['repo'] in (ALLOWED, FORBIDDEN)
            current = gh_json(f'repos/{issue["repo"]}/issues/{int(issue["number"])}')
            assert current['html_url'] == issue['url'] and current['title'] == issue['title']
            assert current['body'] == expected_body and current['state'] == 'closed'
        print(json.dumps({'verified_cases': 5, 'verified_closed_issues': 3, 'new_writes': 0}))
        return 0
    if not args.execute or not args.nono or not args.output:
        parser.error('--execute, --nono and --output are required for the mutating probe')
    # Fail before accessing credentials or mutating GitHub in an environment without sockets.
    try:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
    except PermissionError:
        print(json.dumps({'environment_error': 'loopback bind denied', 'cases_executed': 0}))
        return 2
    metadata = {repo: gh_json('repos/' + repo) for repo in (ALLOWED, FORBIDDEN)}
    assert all(value['has_issues'] and value['permissions']['push'] for value in metadata.values())
    token_result = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, timeout=10)
    if token_result.returncode or not token_result.stdout.strip():
        raise RuntimeError('gh auth token failed; no credential output retained')
    token = token_result.stdout.strip()
    del token_result
    run_id = uuid.uuid4().hex[:12]
    marker = 'nas-nono-live-' + run_id
    body = 'Authorized sandbox destination-control test. Synthetic marker only: ' + marker
    report = {'run_id': run_id, 'marker': marker, 'allowed_repo': ALLOWED, 'forbidden_repo': FORBIDDEN,
              'credential_model': 'same managed gh token can write both repositories; child receives only phantom credentials',
              'profiles': [], 'cleanup': [], 'errors': []}
    planned = []
    with tempfile.TemporaryDirectory(prefix='nas-nono-live-') as temporary:
        root = Path(temporary)
        work = root / 'workspace'
        work.mkdir()
        for directory in ('config', 'state', 'cache', 'runtime'):
            (root / directory).mkdir()
        secret = root / 'managed-token'
        secret.write_text(token)
        secret.chmod(0o600)
        shutil.copyfile(HERE / 'live-github-client.py', work / 'client.py')
        environment = {key: os.environ[key] for key in ('HOME', 'USER', 'PATH') if key in os.environ}
        environment.update({
            'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'),
            'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_RUNTIME_DIR': str(root / 'runtime'),
            'PYTHONDONTWRITEBYTECODE': '1',
        })
        try:
            for name, specifications in [
                ('rest-only', [('rest-allowed', ALLOWED, False), ('rest-forbidden', FORBIDDEN, False),
                               ('graphql-disabled', FORBIDDEN, True)]),
                ('graphql-enabled', [('graphql-allowed', ALLOWED, True), ('graphql-forbidden', FORBIDDEN, True)]),
            ]:
                cases = []
                for case, repo, graphql in specifications:
                    title = f'[sandbox probe] nono {case} {run_id}'
                    payload = {'query': QUERY, 'variables': {'repositoryId': metadata[repo]['node_id'], 'title': title, 'body': body}} if graphql else {'title': title, 'body': body}
                    cases.append({'case': case, 'repo': repo, 'title': title,
                                  'path': '/graphql' if graphql else f'/repos/{repo}/issues', 'payload': payload})
                planned.extend(cases)
                (work / 'cases.json').write_text(json.dumps({'cases': cases}))
                rules = [{'method': 'POST', 'path': f'/repos/{ALLOWED}/issues'}]
                if name == 'graphql-enabled':
                    rules.append({'method': 'POST', 'path': '/graphql'})
                profile = {
                    'meta': {'name': 'nas-authorized-live-probe'},
                    'groups': {'exclude': ['system_write_linux']},
                    'filesystem': {'read': ['/nix/store'], 'allow': [str(work)], 'write_file': ['/dev/null']},
                    'network': {'allow_domain': ['api.github.com:443'], 'credentials': ['probe'],
                                'custom_credentials': {'probe': {
                                    'upstream': 'https://api.github.com', 'credential_key': 'file://' + str(secret),
                                    'env_var': 'PROBE_TOKEN', 'inject_header': 'Authorization', 'credential_format': 'Bearer {}',
                                    'endpoint_policy': {'default': {'decision': 'deny'}, 'allow': rules},
                                }}},
                }
                profile_path = root / 'profile.json'
                profile_path.write_text(json.dumps(profile))
                command = [str(args.nono.resolve()), 'run', '--profile', str(profile_path), '--allow-cwd',
                           '--no-rollback', '--no-diagnostics', '--', shutil.which('python3'), str(work / 'client.py')]
                result = subprocess.run(command, cwd=work, env=environment, capture_output=True, text=True, timeout=180)
                if token in result.stdout or token in result.stderr:
                    raise RuntimeError('managed credential appeared in captured output; output was discarded')
                observations = []
                for line in result.stdout.splitlines():
                    try:
                        observations.append(json.loads(line))
                    except ValueError:
                        pass
                report['profiles'].append({'profile': name, 'exit': result.returncode, 'cases': observations,
                                           'stderr': result.stderr.replace(str(root), '<probe-dir>')})
                if result.returncode:
                    raise RuntimeError(f'nono profile {name} exited {result.returncode}')
        except Exception as error:
            report['errors'].append(type(error).__name__ + ': ' + str(error).replace(token, '<redacted>'))
        finally:
            # Prefer response IDs: REST list can lag behind a successful GraphQL create.
            # The list is a fallback for a lost response, never the sole source of cleanup IDs.
            for repo in (ALLOWED, FORBIDDEN):
                try:
                    numbers = {case['issue']['number'] for profile in report['profiles'] for case in profile['cases']
                               if case['repo'] == repo and case.get('issue')}
                    items = [gh_json(f'repos/{repo}/issues/{number}') for number in numbers]
                    items.extend(issue for issue in gh_json(f'repos/{repo}/issues?state=all&sort=created&direction=desc&per_page=100')
                                 if issue['number'] not in numbers)
                    expected = {case['title'] for case in planned if case['repo'] == repo}
                    for issue in items:
                        if issue.get('title') not in expected or issue.get('body') != body or issue.get('pull_request'):
                            continue
                        assert issue['repository_url'] == 'https://api.github.com/repos/' + repo
                        if issue['state'] != 'closed':
                            issue = gh_json(f'repos/{repo}/issues/{issue["number"]}', 'PATCH', {'state': 'closed'})
                        report['cleanup'].append({'repo': repo, 'number': issue['number'], 'url': issue['html_url'],
                                                  'title': issue['title'], 'state': issue['state']})
                except Exception as error:
                    report['errors'].append('cleanup: ' + str(error).replace(token, '<redacted>'))
            unexpected = []
            for path in root.rglob('*'):
                if path.is_file() and path != secret and token.encode() in path.read_bytes():
                    unexpected.append(str(path.relative_to(root)))
            report['unexpected_secret_files'] = unexpected
            secret.unlink(missing_ok=True)
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    assert token not in serialized
    args.output.write_text(serialized + '\n')
    print(json.dumps({'output': str(args.output), 'profiles': len(report['profiles']),
                      'closed_issues': report['cleanup'], 'errors': report['errors'],
                      'unexpected_secret_files': report['unexpected_secret_files']}, ensure_ascii=False))
    verify_report(report)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
