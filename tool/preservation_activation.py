import os,socket,stat,json,pathlib
from preservation_hardened import Hardened,serve_one
def inherited():
    if os.environ.get('LISTEN_PID')!=str(os.getpid()) or os.environ.get('LISTEN_FDS')!='1': raise RuntimeError('ACTIVATION_REQUIRED')
    s=socket.socket(fileno=3)
    if s.family!=socket.AF_UNIX or s.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)!=socket.SOCK_STREAM or not s.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN): raise RuntimeError('INVALID_SOCKET')
    return s
def main():
    if os.getuid()!=1000: raise PermissionError('ALEX_REQUIRED')
    # Candidate intentionally fails closed until immutable deployment configuration exists.
    raise RuntimeError('IMMUTABLE_DEPLOYMENT_NOT_CONFIGURED')
if __name__=='__main__':main()
