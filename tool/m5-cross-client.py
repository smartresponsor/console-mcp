import json,os,pathlib,re,socket,stat,struct,sys
def main():
 assert os.getuid()==993
 path=sys.argv[1]
 root=str(pathlib.Path(__file__).resolve().parent.parent)
 assert re.fullmatch(re.escape(root)+r'/\.m5-[a-z0-9_]{8}/s',path)
 parent=os.stat(os.path.dirname(path),follow_symlinks=False)
 st=os.stat(path,follow_symlinks=False)
 assert stat.S_ISDIR(parent.st_mode) and parent.st_uid==1000 and parent.st_gid==1001 and stat.S_IMODE(parent.st_mode)==0o710
 assert stat.S_ISSOCK(st.st_mode) and st.st_uid==1000 and st.st_gid==1001 and stat.S_IMODE(st.st_mode)==0o660
 def call(operation,request_id,repository='fixture'):
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
   s.settimeout(35);s.connect(path)
   assert struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]==1000
   s.sendall(json.dumps(dict(version=1,operation=operation,requestId=request_id,repository=repository)).encode()+b'\n')
   with s.makefile('rb') as f:raw=f.readline(65537)
   assert raw.endswith(b'\n') and len(raw)<=65536
   result=json.loads(raw);assert result.get('requestId')==request_id,result
   return result
 denied=call('baseline','unknown-repo','invalid-alias')
 assert denied['status']=='REJECTED' and denied['reason']=='REPO',denied
 first=call('baseline','cross-m5-before')
 assert first['status']=='BASELINE_COMPLETE' and first['uid']==1000,first
 preserve=call('preserve','cross-m5');assert preserve['status']=='COMPLETE',preserve
 replay=call('preserve','cross-m5');assert replay==preserve,replay
 last=call('baseline','cross-m5-after');assert last['status']=='BASELINE_COMPLETE' and last['baseline']==first['baseline'],last
 print(json.dumps(dict(status='M5_CROSS_UID_CLIENT_PASS',client_uid=os.getuid(),server_uid=1000,unknown_repository_denied=True,baseline=first['baseline'],report_sha256=preserve['sha256'])))
if __name__=='__main__':main()
