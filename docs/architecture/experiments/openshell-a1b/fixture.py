import json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
 def handle_request(self):
  body=self.rfile.read(int(self.headers.get('Content-Length','0'))).decode()
  auth=self.headers.get('Authorization','')
  identity='managed' if auth=='Bearer nas-managed-fake' else 'attacker' if auth=='Bearer nas-attacker-fake' else 'absent' if not auth else 'other'
  result={'method':self.command,'path':self.path,'identity':identity,'body':body}
  print(json.dumps(result),flush=True)
  data=json.dumps(result).encode()
  self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 do_GET=handle_request
 do_POST=handle_request
 do_PUT=handle_request
 def log_message(self,*args): pass
import argparse, threading
args=argparse.ArgumentParser(); args.add_argument('--host',default='172.17.0.1'); args.add_argument('--ports',default='27680,27681'); config=args.parse_args()
servers=[ThreadingHTTPServer((config.host,int(port)),Handler) for port in config.ports.split(',')]
for server in servers[:-1]: threading.Thread(target=server.serve_forever,daemon=True).start()
servers[-1].serve_forever()
