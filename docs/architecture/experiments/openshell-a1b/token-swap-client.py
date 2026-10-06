"""Run the real gh issue create with either the provider placeholder or a stdin token."""
import json
import os
import re
import subprocess
import sys

spec = json.loads(sys.stdin.readline())
env = dict(os.environ)
env['GH_TOKEN'] = spec.get('attacker_token') or os.environ['NAS_GITHUB_PROBE_TOKEN']
env['GH_PROMPT_DISABLED'] = '1'
env['GH_CONFIG_DIR'] = '/tmp/nas-token-swap-gh-config'
request = ['/usr/bin/gh', 'issue', 'create', '--repo', spec['repo'], '--title', spec['title'], '--body', spec['body']]
r = subprocess.run(request, text=True, capture_output=True, env=env, timeout=40)
# Credential values remain in memory and are never included in command arguments.
if spec.get('attacker_token') and (spec['attacker_token'] in r.stdout or spec['attacker_token'] in r.stderr):
    raise RuntimeError('credential found in gh output; suppressed')
result = {'repo': spec['repo'], 'exit_code': r.returncode}
match = re.search(r'https://github\.com/' + re.escape(spec['repo']) + r'/issues/(\d+)', r.stdout)
if r.returncode == 0 and match:
    result.update(url=match.group(0), number=int(match.group(1)), status='created')
else:
    # Parent scans both real credentials again before any output is saved.
    result.update(status='gh_failed', error=r.stderr[:2000])
print(json.dumps(result))
