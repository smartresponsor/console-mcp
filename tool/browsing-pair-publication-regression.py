#!/usr/bin/python3
import hashlib,os,runpy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
M=runpy.run_path(str(Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment/browsing-pair-publication.py'))
F=M['FILES'];G='a'*32;U=os.getuid()
class Test(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.root=Path(self.t.name)
        for p in ('opt','opt/console-mcp-deploy','etc','etc/systemd','etc/systemd/system'):
            q=self.root/p;q.mkdir(mode=0o700);q.chmod(0o700)
        self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        self.data={p:('fixture:'+str(p)+'\n').encode() for p in F}
        self.plan=dict(activationEligible=False,files={str(p):hashlib.sha256(v).hexdigest() for p,v in self.data.items()})
    def tearDown(self):os.close(self.fd);self.t.cleanup()
    def path(self,p):return self.root/str(p).lstrip('/')
    def go(self,install):return M['reconcile'](self.fd,self.data,self.plan,G,U,install)
    def test_install_restore(self):
        self.assertEqual(len(self.go(True)['changed']),6)
        self.assertEqual(self.go(True)['changed'],[])
        self.assertEqual(len(self.go(False)['changed']),6)
        self.assertEqual(self.go(False)['changed'],[])
    def test_partial_install_restore(self):
        original=M['publish_one']
        for stop in range(6):
            count=0
            def interrupted(*a):
                nonlocal count
                result=original(*a);count+=1
                if count==stop+1:raise OSError('fixture interruption after effect')
                return result
            with patch.dict(M['reconcile'].__globals__,publish_one=interrupted):
                with self.assertRaises(OSError):self.go(True)
            self.go(False)
            self.assertTrue(all(not self.path(p).exists() for p in F))
    def test_partial_restore_resume(self):
        original=M['restore_one']
        for stop in range(6):
            self.go(True);count=0
            def interrupted(*a):
                nonlocal count
                result=original(*a);count+=1
                if count==stop+1:raise OSError('fixture interruption')
                return result
            with patch.dict(M['reconcile'].__globals__,restore_one=interrupted):
                with self.assertRaises(OSError):self.go(False)
            self.go(False)
    def test_stage_left_after_crash(self):
        p=self.path(F[0]);temp=p.with_name(M['temporary_name'](p.name,G))
        temp.write_bytes(b'partial');temp.chmod(0o600)
        self.go(True);self.assertFalse(temp.exists())
    def test_stage_symlink(self):
        p=self.path(F[0]);temp=p.with_name(M['temporary_name'](p.name,G));temp.symlink_to('/dev/null')
        with self.assertRaisesRegex(RuntimeError,'TEMP_UNTRUSTED'):self.go(True)
    def test_existing_drift(self):
        p=self.path(F[0]);p.write_bytes(b'old');p.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_DRIFT'):self.go(True)
        self.assertEqual(p.read_bytes(),b'old')
    def test_restore_drift(self):
        self.go(True);p=self.path(F[-1]);p.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_DRIFT'):self.go(False)
        self.assertEqual(p.read_bytes(),b'changed')
    def test_late_conflict_prevents_all_mutation(self):
        p=self.path(F[-1]);p.parent.mkdir(mode=0o700);p.parent.chmod(0o700);p.write_bytes(b'foreign');p.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_DRIFT'):self.go(True)
        self.assertTrue(all(not self.path(q).exists() for q in F[:-1]))
        self.assertEqual(p.read_bytes(),b'foreign')
    def test_missing_protected_ancestor_is_not_absence(self):
        (self.root/'opt/console-mcp-deploy').rmdir()
        with self.assertRaisesRegex(RuntimeError,'ANCESTOR_MISSING'):self.go(False)
    def test_real_process_exit_after_atomic_publication(self):
        import subprocess,sys
        script='import os,runpy,hashlib\n'+f'm=runpy.run_path({str(Path(__file__).resolve().parents[1]/"ops/ubuntu/deployment/browsing-pair-publication.py")!r})\n'+f'fd=os.open({str(self.root)!r},os.O_RDONLY|os.O_DIRECTORY)\n'+"f=m['FILES']; data={p:('fixture:'+str(p)+'\\n').encode() for p in f}\nplan=dict(activationEligible=False,files={str(p):hashlib.sha256(v).hexdigest() for p,v in data.items()})\norig=m['publish_one'];g=m['reconcile'].__globals__\ndef crash(*a):\n orig(*a);os._exit(97)\ng['publish_one']=crash\n"+f"m['reconcile'](fd,data,plan,{G!r},os.getuid(),True)\n"
        r=subprocess.run([sys.executable,'-I','-B','-c',script],timeout=10)
        self.assertEqual(r.returncode,97)
        self.assertEqual(self.path(F[0]).read_bytes(),self.data[F[0]])
        self.go(False)
        self.assertTrue(all(not self.path(q).exists() for q in F))
    def test_plan_drift(self):
        self.plan['files'][str(F[0])]='0'*64
        with self.assertRaisesRegex(RuntimeError,'PLAN_DRIFT'):self.go(True)
    def test_symlink_parent(self):
        p=self.path(F[3]).parent;p.symlink_to(self.root/'opt')
        with self.assertRaises(OSError):self.go(True)
    def test_no_replace(self):
        p=self.path(F[0]);p.write_bytes(b'old');p.chmod(0o644)
        src=p.with_name('stage');src.write_bytes(b'new')
        fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:
            with self.assertRaises(FileExistsError):M['rename_noreplace'](fd,src.name,p.name)
        finally:os.close(fd)
        self.assertEqual(p.read_bytes(),b'old')
    def test_hardlink(self):
        p=self.path(F[0]);p.write_bytes(self.data[F[0]]);p.chmod(0o644);os.link(p,p.with_name('alias'))
        with self.assertRaisesRegex(RuntimeError,'PUBLICATION_MEMBER'):self.go(True)
if __name__=='__main__':unittest.main(verbosity=2)
