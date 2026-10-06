"""Runs only inside nono. The real GitHub token is never supplied to this process."""
import base64
import http.client
import json
import os
from pathlib import Path
import ssl
import time
import urllib.parse

config = json.loads(Path('cases.json').read_text())
proxy = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
base = urllib.parse.urlsplit(os.environ['PROBE_BASE_URL'])
assert proxy.scheme == 'http' and proxy.hostname == '127.0.0.1'
assert base.hostname == proxy.hostname and base.port == proxy.port
proxy_auth = base64.b64encode(
    (urllib.parse.unquote(proxy.username or '') + ':' + urllib.parse.unquote(proxy.password or '')).encode()
).decode()
context = ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])

for case in config['cases']:
    time.sleep(0.5)
    connection = http.client.HTTPSConnection(proxy.hostname, proxy.port, timeout=30, context=context)
    result = {'case': case['case'], 'repo': case['repo'], 'title': case['title']}
    try:
        connection.set_tunnel('api.github.com', 443, headers={'Proxy-Authorization': 'Basic ' + proxy_auth})
        connection.request('POST', case['path'], body=json.dumps(case['payload']).encode(), headers={
            # A deliberately invalid client credential; nono must inject the managed one.
            'Authorization': 'Bearer nas-live-probe-not-a-real-token',
            'User-Agent': 'nas-authorized-sandbox-probe',
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
        })
        response = connection.getresponse()
        result['status'] = response.status
        try:
            data = json.loads(response.read())
        except ValueError:
            data = {}
        issue = ((data.get('data') or {}).get('createIssue') or {}).get('issue') if case['path'] == '/graphql' else data
        if issue and issue.get('number'):
            result['issue'] = {
                'number': issue['number'], 'url': issue.get('html_url', issue.get('url')),
                'node_id': issue.get('node_id', issue.get('id')),
            }
        if data.get('errors'):
            result['graphql_errors'] = [{'type': error.get('type'), 'message': error.get('message')}
                                        for error in data['errors']]
    except Exception as error:
        result['error'] = type(error).__name__
    finally:
        connection.close()
    print(json.dumps(result), flush=True)
