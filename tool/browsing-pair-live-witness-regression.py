#!/usr/bin/python3
import json,runpy,threading,unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
M=runpy.run_path(str(Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment/browsing-pair-live-witness.py'))
TOKEN='t'*32
DRAIN='d'*32
G='a'*32
class Worker(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def do_POST(self):
        if self.headers.get('Authorization')!='Bearer '+TOKEN:
            code,value=401,{'ok':False}
        elif self.path=='/worker-drain-status':
            if self.headers.get('x-browser-worker-drain-token')!=DRAIN:
                code,value=403,{'ok':False,'status':'WORKER_DRAIN_CONTROL_UNAVAILABLE'}
            else:code,value=200,dict(ok=True,status='WORKER_DRAINED',draining=True,activeOperations=0,drained=True,mutation_attempted=False,browser_mutated=False)
        else:code,value=404,dict(ok=False,status='WEB_SHARED_LEASE_ROUTE_DENIED',mutation_attempted=False)
        raw=json.dumps(value).encode()
        self.send_response(code);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
class Test(unittest.TestCase):
    def test_real_http(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Worker)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        try:
            r=M['worker_protocol'](TOKEN,DRAIN,server.server_address[1])
            self.assertEqual(r,dict(status='PAIR_WORKER_PROTOCOL_PASS',draining=True,activeOperations=0,drained=True))
            self.assertNotIn(TOKEN,json.dumps(r))
        finally:server.shutdown();server.server_close();t.join(3)
    def test_worker_barrier_required(self):
        def call(*a):
            if len(a)==2:return 401,{'ok':False}
            if a[1]=='/lease-v1/not-a-route':return 404,{'status':'WEB_SHARED_LEASE_ROUTE_DENIED','mutation_attempted':False}
            if len(a)==3:return 403,{'status':'WORKER_DRAIN_CONTROL_UNAVAILABLE'}
            return 200,dict(ok=True,status='WORKER_DRAINED',draining=True,activeOperations=0,drained=True,mutation_attempted=False,browser_mutated=False,**barrier)
        barrier={}
        with self.assertRaisesRegex(RuntimeError,'WORKER_STARTUP_BARRIER'):M['worker_protocol'](TOKEN,DRAIN,call=call,generation=G)
        barrier.update(ingressProtocol=1,ingressState='quiescing',ingressGeneration=G)
        self.assertEqual(M['worker_protocol'](TOKEN,DRAIN,call=call,generation=G)['ingressGeneration'],G)
        barrier['ingressGeneration']='b'*32
        with self.assertRaisesRegex(RuntimeError,'WORKER_STARTUP_BARRIER'):M['worker_protocol'](TOKEN,DRAIN,call=call,generation=G)
    def test_unprotected(self):
        with self.assertRaisesRegex(RuntimeError,'BEARER_REQUIRED'):
            M['worker_protocol'](TOKEN,DRAIN,call=lambda *a:(200,{'ok':True}))
    def test_same_token(self):
        with self.assertRaisesRegex(RuntimeError,'AUTH_CONFIGURATION'):M['worker_protocol'](TOKEN,TOKEN)
    def test_invalid_route(self):
        with self.assertRaisesRegex(RuntimeError,'WITNESS_ROUTE'):M['request'](1,'/click',TOKEN)
    def test_listener(self):
        line='LISTEN 0 511 127.0.0.1:8791 0.0.0.0:* users:(("node",pid=123,fd=17))'
        self.assertEqual(M['listener_pid'](8791,lambda *a,**kw:line),123)
        for bad in (line.replace('127.0.0.1','0.0.0.0'),line+'\n'+line,line.replace('pid=123','pid=123,pid=456')):
            with self.assertRaisesRegex(RuntimeError,'WITNESS_LISTENER'):M['listener_pid'](8791,lambda *a,**kw:bad)
    def test_legacy(self):
        with self.assertRaisesRegex(RuntimeError,'LEGACY_INGRESS_UNSUPPORTED'):M['ingress_health']({'ok':True,'pid':123},123)
    def test_ingress(self):
        x=dict(ok=True,pid=123,ingress=dict(protocol=1,enabled=True,generation=G,state='quiescing',activeHandlers=0,drained=True))
        self.assertTrue(M['ingress_health'](x,123,G)['drained'])
        x['ingress']['activeHandlers']=1
        with self.assertRaisesRegex(RuntimeError,'INGRESS_NOT_DRAINED'):M['ingress_health'](x,123,G)
    def test_duplicate_json(self):
        with self.assertRaisesRegex(RuntimeError,'DUPLICATE_JSON'):json.loads('{"ok":true,"ok":false}',object_pairs_hook=M['unique'])
if __name__=='__main__':unittest.main(verbosity=2)
