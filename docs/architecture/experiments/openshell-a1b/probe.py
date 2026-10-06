#!/usr/bin/env python3
"""Disposable OpenShell v0.1.2 probe. Docker host access is required. All tokens are fake."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

SOURCE = Path(__file__).resolve().parent
p = argparse.ArgumentParser()
p.add_argument('--cli', required=True, help='Official OpenShell v0.1.2 CLI binary')
p.add_argument('--work', help='New output directory; defaults to a fresh /tmp directory')
p.add_argument('--port', type=int, default=27670)
p.add_argument('--fixture-port', type=int, default=27680)
a = p.parse_args()
work = Path(a.work).resolve() if a.work else Path(tempfile.mkdtemp(prefix='nas-openshell-a1b-'))
work.mkdir(parents=True, exist_ok=True)
if any(work.iterdir()):
    raise SystemExit('--work must be empty')
(work/'logs').mkdir(); (work/'state').mkdir(); (work/'config').mkdir()
run_id = 'nas-a1b-' + format(time.time_ns(), 'x')[-10:]
gateway = run_id + '-gateway'
image = 'nas-a1b-openshell-client:20261006'
cli = str(Path(a.cli).resolve())
env = {'PATH': os.environ['PATH'], 'XDG_CONFIG_HOME': str(work/'config'), 'OPENSHELL_COLOR': 'never'}
fixture = None
created_gateway = False

def command(args, *, log=None, check=True, input=None, clean_env=False):
    r = subprocess.run(args, text=True, input=input, capture_output=True,
                       env=env if clean_env else None)
    if log: (work/'logs'/log).write_text(r.stdout + r.stderr)
    if check and r.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed ({r.returncode}); see {log or "command output"}: {r.stderr[:1000]}')
    return r

def oshell(*args, **kwargs):
    return command([cli, *args], clean_env=True, **kwargs)

try:
    bridge = command(['docker','network','inspect','bridge','--format','{{(index .IPAM.Config 0).Gateway}}']).stdout.strip()
    for name in ['policy.yaml','profile.yaml','client.py','fixture.py','Dockerfile']:
        text = (SOURCE/name).read_text().replace('172.17.0.1', bridge)
        text = text.replace('27680',str(a.fixture_port)).replace('27681',str(a.fixture_port+1))
        (work/name).write_text(text)
    command(['docker','build','-t',image,str(work)], log='build.log')
    command(['docker','pull','ghcr.io/nvidia/openshell/gateway:0.1.2'],log='pull.log')
    command(['docker','run','--rm','--user',str(os.getuid())+':'+str(os.getgid()),'-v',f'{work}:{work}',
             'ghcr.io/nvidia/openshell/gateway:0.1.2','generate-certs','--output-dir',str(work/'tls'),
             '--server-san','host.openshell.internal'],log='certgen.log')
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
    command(['docker','run','-d','--name',gateway,'--network','host','--user','0',
             '-v','/var/run/docker.sock:/var/run/docker.sock','-v',f'{work}:{work}',
             '-e',f'OPENSHELL_LOCAL_TLS_DIR={work}/tls',
             '-e',f'XDG_DATA_HOME={work}/state','-e',f'OPENSHELL_DB_URL=sqlite:{work}/state/gateway.db?mode=rwc',
             '-e','OPENSHELL_TELEMETRY_ENABLED=false',
             'ghcr.io/nvidia/openshell/gateway:0.1.2','--config',str(work/'gateway.toml')],log='gateway-create.log')
    created_gateway = True
    mtls = work/'config'/'openshell'/'gateways'/run_id/'mtls'
    mtls.mkdir(parents=True)
    for src in ['ca.crt','client/tls.crt','client/tls.key']:
        shutil.copyfile(work/'tls'/src,mtls/Path(src).name)
    for attempt in range(40):
        r=oshell('gateway','add',f'https://127.0.0.1:{a.port}','--local','--name',run_id,check=False,log='gateway-register.log')
        if r.returncode==0:break
        time.sleep(1)
    else:raise RuntimeError('gateway did not become ready')
    fixture_log=open(work/'logs'/'fixture.jsonl','w')
    fixture=subprocess.Popen(['python3',str(work/'fixture.py'),'--host',bridge,'--ports',f'{a.fixture_port},{a.fixture_port+1}'],stdout=fixture_log,stderr=fixture_log)
    time.sleep(.2)
    if fixture.poll() is not None:raise RuntimeError('fixture failed to start; check port availability')
    command(['curl','--silent','--show-error','--noproxy','*',f'http://{bridge}:{a.fixture_port+1}/control'],log='forbidden-destination-host-control.json')
    oshell('profile','import','-f',str(work/'profile.yaml'),log='profile-import.log')
    oshell('provider','create','--name','nas-a1b-fake','--type','nas-a1b-fixture','--credential','NAS_FIXTURE_TOKEN=nas-managed-fake',log='provider-create.log')
    oshell('sandbox','create','--name',run_id,'--from',image,'--policy',str(work/'policy.yaml'),'--provider','nas-a1b-fake','--no-auto-providers','--no-tty','--detach','--','sleep','infinity',log='sandbox-create.log')
    r=oshell('sandbox','exec','--name',run_id,'--no-tty','--no-login-shell','--','python3','-',input=(work/'client.py').read_text())
    (work/'logs'/'results.jsonl').write_text(r.stdout)
    (work/'logs'/'exec.stderr').write_text(r.stderr)
    oshell('logs',run_id,'-n','1000',log='openshell.log')
    oshell('policy','get',run_id,'--full','-o','json',log='effective-policy.json')
finally:
    if created_gateway:
        oshell('sandbox','delete',run_id,check=False,log='sandbox-delete.log')
        # Restrict all fallback cleanup to this run's namespace, never global prune.
        selector=f'label=openshell.ai/sandbox-namespace={run_id}'
        for _ in range(20):
            ids=command(['docker','ps','-aq','--filter',selector],check=False).stdout.split()
            if not ids:break
            time.sleep(.25)
        if ids:command(['docker','rm','-f',*ids],check=False,log='container-cleanup.log')
        command(['docker','logs',gateway],check=False,log='gateway.log')
        command(['docker','rm','-f',gateway],check=False,log='gateway-delete.log')
        for kind in ['network','volume']:
            ids=command(['docker',kind,'ls','-q','--filter',selector],check=False).stdout.split()
            if ids:command(['docker',kind,'rm',*ids],check=False,log=kind+'-cleanup.log')
        remaining={kind:command(['docker',kind,'ls','-q','--filter',selector],check=False).stdout.split() for kind in ['network','volume']}
        remaining['containers']=command(['docker','ps','-aq','--filter',selector],check=False).stdout.split()
        (work/'logs'/'cleanup.json').write_text(json.dumps(remaining,indent=2)+'\n')
    if fixture:
        fixture.terminate()
        try:fixture.wait(timeout=5)
        except subprocess.TimeoutExpired:fixture.kill();fixture.wait()
    # Remove only newly generated authentication/state files; keep evidence and image cache.
    command(['docker','run','--rm','--user','0','-v',f'{work}:{work}',image,
             'python3','-c','import shutil,sys; [shutil.rmtree(p,ignore_errors=True) for p in sys.argv[1:]]',
             str(work/'tls'),str(work/'config'),str(work/'state')],check=False,log='state-cleanup.log')
    print(f'Evidence: {work}/logs')
