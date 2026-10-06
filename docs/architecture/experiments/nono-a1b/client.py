import http.client
import ssl
import base64
import json
import os
import socket
import time
import urllib.parse

ATTACKER = 'nas-probe-attacker-token-not-a-real-secret'
BASE = urllib.parse.urlsplit(os.environ['PROBE_BASE_URL'])
TOKEN = os.environ['PROBE_TOKEN']


def probe(name, method, path, kind='owner', duplicate=False, direct=False):
    time.sleep(0.25)  # nono seccomp supervisor refills at 10 requests/sec (burst 5).
    host = BASE.hostname
    port = int(os.environ['PROBE_FIXTURE_PORT']) if direct else BASE.port
    target = path if direct else BASE.path.rstrip('/') + path
    headers = {'X-Probe-Case': name}
    if kind == 'owner':
        headers['Authorization'] = 'Bearer ' + TOKEN
    elif kind == 'attacker':
        headers['Authorization'] = 'Bearer ' + ATTACKER
    elif kind == 'basic':
        headers['Authorization'] = 'Basic bmFzOmF0dGFja2Vy'
    elif kind == 'cookie':
        headers['Authorization'] = 'Bearer ' + TOKEN
        headers['Cookie'] = 'user_session=' + ATTACKER
    body = json.dumps({'canary': 'synthetic-source-marker', 'case': name}) if method == 'POST' else ''
    if path == '/graphql':
        body = json.dumps({'query': 'mutation { createIssue(input:{repositoryId:"ATTACKER_REPO",title:"synthetic-source-marker"}) { issue { id } } }'})
    connection = http.client.HTTPConnection(host, port, timeout=5)
    try:
        connection.putrequest(method, target)
        for key, value in headers.items():
            connection.putheader(key, value)
        if duplicate:
            connection.putheader('authorization', 'Bearer ' + ATTACKER)
        connection.putheader('Content-Length', str(len(body.encode())))
        connection.endheaders(body.encode())
        response = connection.getresponse()
        content = response.read().decode(errors='replace')
        # Raw body can contain proxy errors. All tokens in this experiment are fake;
        # remove the per-session token anyway before retaining output.
        content = content.replace(TOKEN, '<session-token>')
        print(json.dumps({'case': name, 'status': response.status, 'body': content}), flush=True)
    except Exception as e:
        print(json.dumps({'case': name, 'error': type(e).__name__, 'detail': str(e)}), flush=True)
    finally:
        connection.close()


probe('C0-owner-control', 'GET', '/whoami')
probe('C1-owner-write-control', 'POST', '/repos/trusted/private/issues')
probe('C2-attacker-token', 'GET', '/whoami', 'attacker')
probe('C3-basic-token', 'GET', '/whoami', 'basic')
probe('C4-missing-token', 'GET', '/whoami', 'missing')
probe('C5-duplicate-auth', 'GET', '/whoami', duplicate=True)
probe('C6-cookie-with-owner', 'GET', '/whoami', 'cookie')
probe('C7-forbidden-repo', 'POST', '/repos/attacker/stolen/issues')
probe('C8-forbidden-method', 'DELETE', '/repos/trusted/private/issues')
probe('C9-direct-local-fixture', 'GET', '/whoami', 'attacker', direct=True)
probe('C10-dot-path', 'POST', '/repos/trusted/private/../../attacker/stolen/issues')
probe('C11-encoded-dot-path', 'POST', '/repos/trusted/private/%2e%2e/%2e%2e/attacker/stolen/issues')
probe('C12-graphql-attacker-repo', 'POST', '/graphql')
probe('C13-redirect', 'GET', '/redirect')

probe('C14-after-control', 'GET', '/whoami')

# TLS terminates only at the fake fixture. The generated certificate is local-only.
time.sleep(0.25)
proxy = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
assert proxy.scheme == 'http' and proxy.hostname == '127.0.0.1', 'only the nono loopback proxy is allowed'
assert BASE.hostname == '127.0.0.1' and BASE.port == proxy.port, 'must be the same generated local credential proxy'
auth = base64.b64encode((urllib.parse.unquote(proxy.username or '') + ':' + urllib.parse.unquote(proxy.password or '')).encode()).decode()
conn = http.client.HTTPSConnection(proxy.hostname, proxy.port, timeout=5, context=ssl._create_unverified_context())
try:
    conn.set_tunnel('localhost', int(os.environ['PROBE_TLS_PORT']), headers={'Proxy-Authorization': 'Basic ' + auth})
    conn.request('POST', '/repos/attacker/stolen/issues', body='synthetic-source-marker', headers={'Authorization': 'Bearer ' + ATTACKER})
    res = conn.getresponse()
    print(json.dumps({'case': 'C15-forward-tunnel-attacker', 'status': res.status, 'body': res.read().decode()}), flush=True)
except Exception as e:
    print(json.dumps({'case': 'C15-forward-tunnel-attacker', 'error': type(e).__name__, 'detail': str(e)}), flush=True)
finally:
    conn.close()

for case, method, path, body in [
    ('C16-forward-allowed-path-attacker', 'GET', '/whoami', ''),
    ('C17-forward-graphql-attacker', 'POST', '/graphql', json.dumps({'query': 'mutation { createIssue(input:{repositoryId:"ATTACKER_REPO",title:"synthetic-source-marker"}) { issue { id } } }'})),
]:
    time.sleep(0.25)
    conn = http.client.HTTPSConnection(proxy.hostname, proxy.port, timeout=5, context=ssl._create_unverified_context())
    try:
        conn.set_tunnel('localhost', int(os.environ['PROBE_TLS_PORT']), headers={'Proxy-Authorization': 'Basic ' + auth})
        conn.request(method, path, body=body, headers={'Authorization': 'Bearer ' + ATTACKER})
        res = conn.getresponse()
        print(json.dumps({'case': case, 'status': res.status, 'body': res.read().decode()}), flush=True)
    except Exception as e:
        print(json.dumps({'case': case, 'error': type(e).__name__, 'detail': str(e)}), flush=True)
    finally:
        conn.close()
