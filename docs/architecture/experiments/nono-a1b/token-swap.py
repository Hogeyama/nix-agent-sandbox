#!/usr/bin/env python3
"""User-authorized two-token test. Tokens stay in process memory or temporary protected state."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
ALLOWED, OTHER = 'Hogeyama/nix-agent-sandbox', 'Hogeyama/test-github'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nono', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('--execute is required for live write probes')
    try:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
    except PermissionError:
        print(json.dumps({'environment_error': 'loopback bind denied', 'cases_executed': 0}))
        return 2
    ro_result = subprocess.run(['pass', 'github/token/for-agent'], capture_output=True, text=True, timeout=30)
    rw_result = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, timeout=10)
    if ro_result.returncode or rw_result.returncode or not ro_result.stdout.strip() or not rw_result.stdout.strip():
        raise RuntimeError('credential acquisition failed; outputs discarded')
    read_only, attacker = ro_result.stdout.splitlines()[0].strip(), rw_result.stdout.strip()
    del ro_result, rw_result
    assert read_only != attacker
    gh = shutil.which('gh')
    run_id = uuid.uuid4().hex[:12]
    marker = 'nas-two-token-nono-' + run_id
    body = 'Authorized two-token sandbox test. Artificial marker only: ' + marker
    report = {'run_id': run_id, 'marker': marker, 'tokens_distinct': True,
              'registered_source': 'pass github/token/for-agent', 'attacker_source': 'gh auth token',
              'host_cases': [], 'sandbox_cases': [], 'cleanup': [], 'errors': []}
    planned = []

    def safe(value):
        if any(token in value for token in (read_only, attacker)):
            raise RuntimeError('credential found in captured output; discarded')
        return value

    with tempfile.TemporaryDirectory(prefix='nas-nono-swap-') as temporary:
        root = Path(temporary)
        work = root / 'workspace'
        work.mkdir()
        for name in ('config', 'state', 'cache', 'runtime', 'host-gh', 'workspace/gh-config'):
            (root / name).mkdir(exist_ok=True)
        basic_env = {key: os.environ[key] for key in ('PATH', 'HOME', 'USER') if key in os.environ}
        flags = {'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1', 'GH_NO_EXTENSION_UPDATE_NOTIFIER': '1',
                 'GH_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'GH_HOST': 'github.com'}
        host_env = {**basic_env, **flags, 'GH_CONFIG_DIR': str(root / 'host-gh')}

        def host_api(endpoint, method='GET', payload=None):
            command = [gh, 'api', '--method', method, endpoint]
            if payload is not None:
                command += ['--input', '-']
            result = subprocess.run(command, env={**host_env, 'GH_TOKEN': attacker}, cwd=work,
                                    input=json.dumps(payload) if payload is not None else None,
                                    text=True, capture_output=True, timeout=45)
            safe(result.stdout); safe(result.stderr)
            if result.returncode:
                raise RuntimeError('host GitHub API failed: ' + endpoint)
            return json.loads(result.stdout)

        def make_case(name, repo, credential, operation='write'):
            case = {'case': name, 'repo': repo, 'credential': credential, 'operation': operation,
                    'title': '[sandbox probe] nono token-swap ' + name + ' ' + run_id}
            planned.append(case)
            return case

        secret = root / 'registered-token'
        secret.write_text(read_only)
        secret.chmod(0o600)
        try:
            for case in [make_case('host-read-registered', ALLOWED, 'registered', 'read'),
                         make_case('host-write-registered-allowed', ALLOWED, 'registered'),
                         make_case('host-write-registered-other', OTHER, 'registered'),
                         make_case('host-write-attacker-control', OTHER, 'attacker')]:
                credential = attacker if case['credential'] == 'attacker' else read_only
                if case['operation'] == 'read':
                    command = [gh, 'api', 'repos/' + case['repo'], '--jq', '.full_name']
                else:
                    command = [gh, 'issue', 'create', '--repo', case['repo'], '--title', case['title'], '--body-file', '-']
                result = subprocess.run(command, env={**host_env, 'GH_TOKEN': credential}, cwd=work,
                                        input=body if case['operation'] == 'write' else None,
                                        text=True, capture_output=True, timeout=45)
                record = {**case, 'exit': result.returncode, 'stdout': safe(result.stdout.strip()), 'stderr': safe(result.stderr.strip())}
                match = re.search(r'https://github\.com/' + re.escape(case['repo']) + r'/issues/(\d+)', result.stdout)
                if match:
                    record['issue'] = {'number': int(match.group(1)), 'url': match.group(0)}
                report['host_cases'].append(record)
                if case['operation'] == 'read' and result.returncode:
                    raise RuntimeError('registered credential read control failed')
                if case['operation'] == 'write' and case['credential'] == 'registered' and result.returncode == 0:
                    raise RuntimeError('registered token can create this issue; read-only premise did not hold')
                if case['credential'] == 'attacker' and not record.get('issue'):
                    raise RuntimeError('attacker credential positive write control failed')
            report['host_controls_verified'] = True
            shutil.copyfile(HERE / 'token-swap-client.py', work / 'client.py')
            cases = [make_case('nono-read-registered', ALLOWED, 'registered', 'read'),
                     make_case('nono-write-registered-allowed', ALLOWED, 'registered'),
                     make_case('nono-write-attacker-allowed', ALLOWED, 'attacker'),
                     make_case('nono-write-attacker-other', OTHER, 'attacker')]
            profile = {
                'meta': {'name': 'nas-two-token-nono'}, 'groups': {'exclude': ['system_write_linux']},
                'filesystem': {'read': ['/nix/store'], 'allow': [str(work)], 'read_file': [gh], 'write_file': ['/dev/null']},
                'network': {'allow_domain': ['api.github.com:443'], 'credentials': ['probe'], 'custom_credentials': {'probe': {
                    'upstream': 'https://api.github.com', 'credential_key': 'file://' + str(secret),
                    'env_var': 'REGISTERED_TOKEN', 'inject_header': 'Authorization', 'credential_format': 'Bearer {}',
                    'endpoint_policy': {'default': {'decision': 'deny'}, 'allow': [
                        {'method': 'GET', 'path': '/repos/' + ALLOWED},
                        {'method': 'POST', 'path': '/repos/' + ALLOWED + '/issues'},
                        {'method': 'POST', 'path': '/graphql'},
                    ]},
                }}},
            }
            profile_file = root / 'profile.json'
            profile_file.write_text(json.dumps(profile))
            environment = {**basic_env, **flags, 'GH_CONFIG_DIR': str(work / 'gh-config'),
                           'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'),
                           'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_RUNTIME_DIR': str(root / 'runtime'),
                           'PYTHONDONTWRITEBYTECODE': '1'}
            command = [str(args.nono.resolve()), 'run', '--profile', str(profile_file), '--allow-cwd',
                       '--no-rollback', '--no-diagnostics', '--', shutil.which('python3'), str(work / 'client.py')]
            result = subprocess.run(command, env=environment, cwd=work,
                                    input=json.dumps({'gh': gh, 'attacker_token': attacker, 'cases': cases, 'body': body}),
                                    text=True, capture_output=True, timeout=240)
            safe(result.stdout); safe(result.stderr)
            report['nono_exit'] = result.returncode
            report['nono_stderr'] = result.stderr.replace(str(root), '<probe-dir>')
            for line in result.stdout.splitlines():
                try:
                    report['sandbox_cases'].append(json.loads(line))
                except ValueError:
                    pass
            if result.returncode:
                raise RuntimeError('nono client failed to run')
        except Exception as error:
            report['errors'].append(safe(type(error).__name__ + ': ' + str(error)))
        finally:
            for repo in (ALLOWED, OTHER):
                try:
                    observations = report['host_cases'] + report['sandbox_cases']
                    numbers = {case['issue']['number'] for case in observations if case['repo'] == repo and case.get('issue')}
                    issues = [host_api(f'repos/{repo}/issues/{number}') for number in numbers]
                    issues.extend(issue for issue in host_api(f'repos/{repo}/issues?state=all&sort=created&direction=desc&per_page=100')
                                  if issue['number'] not in numbers)
                    titles = {case['title'] for case in planned if case['repo'] == repo}
                    for issue in issues:
                        if issue.get('title') not in titles or issue.get('body') != body or issue.get('pull_request'):
                            continue
                        assert issue['repository_url'] == 'https://api.github.com/repos/' + repo
                        if issue['state'] != 'closed':
                            issue = host_api(f'repos/{repo}/issues/{issue["number"]}', 'PATCH', {'state': 'closed'})
                        report['cleanup'].append({'repo': repo, 'number': issue['number'], 'url': issue['html_url'],
                                                  'title': issue['title'], 'state': issue['state']})
                except Exception as error:
                    report['errors'].append(safe('cleanup: ' + str(error)))
            report['unexpected_secret_files'] = []
            for path in root.rglob('*'):
                if path.is_file() and path != secret:
                    content = path.read_bytes()
                    if any(value.encode() in content for value in (read_only, attacker)):
                        report['unexpected_secret_files'].append(str(path.relative_to(root)))
            secret.unlink(missing_ok=True)
    report['gh_version'] = subprocess.check_output([gh, '--version'], text=True).splitlines()[0]
    report['nono_version'] = subprocess.check_output([str(args.nono), '--version'], text=True).strip()
    encoded = safe(json.dumps(report, ensure_ascii=False, indent=2))
    args.output.write_text(encoded + '\n')
    print(json.dumps({'output': str(args.output), 'host_cases': len(report['host_cases']),
                      'sandbox_cases': len(report['sandbox_cases']), 'cleanup': report['cleanup'],
                      'errors': report['errors'], 'unexpected_secret_files': report['unexpected_secret_files']}, ensure_ascii=False))
    assert not report['errors'] and not report['unexpected_secret_files']
    by_name = {case['case']: case for case in report['sandbox_cases']}
    assert by_name['nono-read-registered']['exit'] == 0
    for name in ('nono-write-registered-allowed', 'nono-write-attacker-allowed', 'nono-write-attacker-other'):
        assert by_name[name]['exit'] != 0 and not by_name[name].get('issue')
    assert len(report['cleanup']) == 1 and all(issue['state'] == 'closed' for issue in report['cleanup'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
