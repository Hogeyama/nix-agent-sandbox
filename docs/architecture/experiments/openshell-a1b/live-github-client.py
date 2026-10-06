"""One request per invocation; stdout contains only selected issue identifiers/status."""
import json
import os
import sys
import urllib.error
import urllib.request

spec = json.loads(sys.stdin.readline())
repo = spec['repo']
if spec['transport'] == 'REST':
    url = 'https://api.github.com/repos/' + repo + '/issues'
    payload = {'title': spec['title'], 'body': spec['body']}
else:
    url = 'https://api.github.com/graphql'
    payload = {'query': 'mutation Probe($input:CreateIssueInput!){createIssue(input:$input){issue{url number id state}}}',
               'variables': {'input': {'repositoryId': spec['repo_id'], 'title': spec['title'], 'body': spec['body']}}}
req = urllib.request.Request(url, data=json.dumps(payload).encode(), method='POST', headers={
    'Authorization': 'Bearer ' + os.environ['NAS_GITHUB_PROBE_TOKEN'],
    'User-Agent': 'nas-openshell-recipient-probe', 'Content-Type': 'application/json',
    'Accept': 'application/vnd.github+json'})
result = {'repo': repo}
try:
    with urllib.request.urlopen(req, timeout=20) as response:
        status = response.status
        data = json.load(response)
except urllib.error.HTTPError as error:
    status = error.code
    data = json.loads(error.read())
except Exception:
    result['status'] = 'transport_error'
    print(json.dumps(result))
    sys.exit(1)
if spec['transport'] == 'REST' and status == 201:
    result.update(url=data['html_url'], number=data['number'], nodeId=data['node_id'], status=data['state'])
elif spec['transport'] == 'GraphQL' and status == 200 and data.get('data', {}).get('createIssue'):
    issue = data['data']['createIssue']['issue']
    result.update(url=issue['url'], number=issue['number'], nodeId=issue['id'], status=issue['state'].lower())
else:
    # Do not emit full API errors, headers, token values, or request bodies.
    result['status'] = 'http_' + str(status)
    if data.get('error') == 'policy_denied': result['status'] += '_policy_denied'
    if data.get('errors'): result['status'] += '_graphql_error'
print(json.dumps(result))
