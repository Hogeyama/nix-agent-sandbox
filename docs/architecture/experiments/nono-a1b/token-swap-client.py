"""Compare registered phantom vs injected attacker token using the actual gh executable."""
import json
import os
import re
import subprocess
import sys
import time

spec = json.load(sys.stdin)
registered = os.environ['REGISTERED_TOKEN']
attacker = spec.pop('attacker_token')
for case in spec['cases']:
    time.sleep(0.5)
    environment = dict(os.environ)
    environment['GH_TOKEN'] = attacker if case['credential'] == 'attacker' else registered
    environment.pop('GITHUB_TOKEN', None)
    command = [spec['gh']]
    if case['operation'] == 'read':
        command += ['api', 'repos/' + case['repo'], '--jq', '.full_name']
        body = None
    else:
        command += ['issue', 'create', '--repo', case['repo'], '--title', case['title'], '--body-file', '-']
        body = spec['body']
    result = subprocess.run(command, input=body, env=environment, text=True, capture_output=True, timeout=45)
    if any(value in result.stdout or value in result.stderr for value in (registered, attacker)):
        raise RuntimeError('credential found in subprocess output; discarded')
    record = {**case, 'exit': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}
    match = re.search(r'https://github\.com/' + re.escape(case['repo']) + r'/issues/(\d+)', result.stdout)
    if match:
        record['issue'] = {'number': int(match.group(1)), 'url': match.group(0)}
    print(json.dumps(record), flush=True)
