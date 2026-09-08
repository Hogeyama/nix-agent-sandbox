from pathlib import Path
import tempfile,re,subprocess,json,shutil
repo=Path.cwd();root=repo/'docs-site/src/content/docs'; count=0
with tempfile.TemporaryDirectory() as td:
 d=Path(td);shutil.copy(repo/'src/config/Schema.pkl',d/'Schema.pkl')
 (d/'global.pkl').write_text('''amends "Schema.pkl"
default = "claude"
profiles {
 ["claude"] { agent = "claude" }
 ["codex"] { agent = "codex"
  extraMounts { new {src = "/existing"; dst = "/existing"} }
  network { scopes { ["existing"] { targets { "example.com:443" }; fallback = "deny" } } }
 }
}''')
 prefix='amends "modulepath:/global.pkl"\nlocal function extendProfile(p: Profile): Profile = (p) {}\n'
 def evalp(source,label):
  (d/'example.pkl').write_text(source)
  r=subprocess.run(['pkl','eval','--module-path',td,'--format','json',str(d/'example.pkl')],capture_output=True,text=True)
  assert r.returncode==0,label+'\n'+r.stderr
  return json.loads(r.stdout)
 quick=re.findall(r'```pkl\n(.*?)\n```',(root/'getting-started/quick-start.md').read_text(),re.S)[0]
 for path in sorted(root.rglob('*.md'))+[repo/'README.md']:
  blocks=re.findall(r'```pkl\n(.*?)\n```',path.read_text(),re.S)
  for i,b in enumerate(blocks):
   label=f'{path.relative_to(repo)} block {i+1}'
   if b.startswith('amends'):source=b
   elif path.stem=='profiles':
    if b.startswith('extraMounts'):source=quick.replace('    network {',b+'\n    network {',1)
    elif b.startswith('["dev"]'):source=prefix+'profiles {\n'+b+'\n}'
    else:source=prefix+b
   elif b.startswith('observability'):source=prefix+b
   elif path.stem=='network' and i==2:
    # This example adds to example-api from the preceding example: use actual Pkl amendment.
    (d/'prior.pkl').write_text(prefix+'profiles { ["claude"] = (super["claude"]) {\n'+blocks[0]+'\n} }')
    source='amends "prior.pkl"\nprofiles { ["claude"] {\n'+b+'\n} }'
   else:
    profile='codex' if path.stem=='authentication' and i==2 else 'claude'
    source=prefix+'profiles { ["'+profile+'"] = (super["'+profile+'"]) {\n'+b+'\n} }'
   v=evalp(source,label);count+=1
   if path.stem=='profiles' and i==1:
    assert [x['src'] for x in v['profiles']['codex']['extraMounts']]==['/existing','~/.cache/my-tool']
    assert 'existing' in v['profiles']['codex']['network']['scopes']
   if path.stem=='profiles' and i==2:assert 'anthropic' in v['profiles']['claude']['network']['scopes']
   if path.stem=='profiles' and i==3:assert v['profiles']['dev']['agent']=='codex' and 'existing' in v['profiles']['dev']['network']['scopes']
   if path.stem=='network' and i==2:
    scope=v['profiles']['claude']['network']['scopes']['example-api'];assert scope['targets']==['api.example.com:443'] and scope['rules']['read-items']['onMatch']=='allow'
   if path.stem=='sessions' and i==0:assert v['profiles']['claude']['session']['detachKey']=='^\\'
   print('PASS',label)
 print('PASS',count,'examples, including inherited scopes/mounts, appended injection, and literal detach key')
