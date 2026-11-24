import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const python = String.raw`
import importlib.util, pathlib, tempfile, json, unittest, ast
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('deploy', 'ops/ubuntu/deployment/deploy.py')
d=importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
class DeploymentTests(unittest.TestCase):
 def test_legacy_rollback_without_worker_unit(self):
  with tempfile.TemporaryDirectory() as tmp:
   tree=pathlib.Path(tmp)/('a'*40); tree.mkdir()
   calls=[]
   with patch.object(d,'verify'), patch.object(d,'atomic'), patch.object(d,'ctl',side_effect=lambda *a:calls.append(a)), patch.object(d,'worker_unit_installed',return_value=False):
    d.restart(tree)
   self.assertNotIn(('stop',d.WORKER_UNIT),calls)
   self.assertIn(('restart',d.UNIT),calls)
   self.assertIn(b'UnsetEnvironment=CONSOLE_MCP_REPO_WRITE_SOCKET',d.override(tree))
 def test_worker_stays_disabled_even_when_release_contains_executable(self):
  with tempfile.TemporaryDirectory() as tmp:
   tree=pathlib.Path(tmp)/('d'*40); worker=tree/'dist/cli/repository-write-worker.js';worker.parent.mkdir(parents=True);worker.write_text('test')
   calls=[]
   with patch.object(d,'verify'),patch.object(d,'atomic'),patch.object(d,'ctl',side_effect=lambda *a:calls.append(a)),patch.object(d,'worker_unit_installed',return_value=False):
    d.restart(tree)
   self.assertFalse(d.WORKER_ENABLED)
   self.assertIn(('restart',d.UNIT),calls)
   self.assertNotIn(('restart',d.WORKER_UNIT),calls)
   self.assertIn(b'UnsetEnvironment=CONSOLE_MCP_REPO_WRITE_SOCKET',d.override(tree))
 def test_worker_restart_failure_prevents_main_restart(self):
  with tempfile.TemporaryDirectory() as tmp:
   tree=pathlib.Path(tmp)/('b'*40); worker=tree/'dist/cli/repository-write-worker.js';worker.parent.mkdir(parents=True);worker.write_text('test')
   calls=[]
   def ctl(*args):
    calls.append(args)
    if args==('restart',d.WORKER_UNIT): raise RuntimeError('injected worker failure')
   with patch.object(d,'WORKER_ENABLED',True),patch.object(d,'verify'),patch.object(d,'atomic'),patch.object(d,'ctl',side_effect=ctl):
    with self.assertRaisesRegex(RuntimeError,'injected worker failure'):d.restart(tree)
   self.assertNotIn(('restart',d.UNIT),calls)
   with patch.object(d,'WORKER_ENABLED',True):
    self.assertIn(b'CONSOLE_MCP_REPO_WRITE_SOCKET=',d.override(tree))
 def test_persistent_worker_pin_survives_reboot(self):
  self.assertEqual(d.WORKER_PIN, d.BASE / 'repository-write-release.env')
  unit=pathlib.Path('ops/ubuntu/systemd/console-mcp-repository-write.service').read_text()
  self.assertIn('EnvironmentFile=/opt/console-mcp-deploy/repository-write-release.env',unit)
  self.assertNotIn('EnvironmentFile=/run/',unit)
  self.assertIn('"$$CONSOLE_MCP_REPO_WRITE_RELEASE_DIR/dist/cli/repository-write-worker.js"',unit)
  self.assertNotIn('"$CONSOLE_MCP_REPO_WRITE_RELEASE_DIR/dist/cli/repository-write-worker.js"',unit)
 def test_worker_pin_readable_by_unprivileged_service(self):
  with tempfile.TemporaryDirectory() as tmp:
   tree=pathlib.Path(tmp)/('c'*40);worker=tree/'dist/cli/repository-write-worker.js';worker.parent.mkdir(parents=True);worker.write_text('test')
   with patch.object(d,'WORKER_PIN',pathlib.Path(tmp)/'worker.env'):
    d.worker_pin(tree)
    self.assertEqual(d.WORKER_PIN.stat().st_mode & 0o777,0o644)
    self.assertIn(str(tree),d.WORKER_PIN.read_text())
 def test_readiness_protocol_uses_real_newline_bytes(self):
  source=pathlib.Path('ops/ubuntu/deployment/deploy.py').read_text()
  tree=ast.parse(source)
  restart=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='restart')
  literals=[n.value for n in ast.walk(restart) if isinstance(n,ast.Constant) and isinstance(n.value,(str,bytes))]
  self.assertIn('\n',literals)
  self.assertIn(b'\n',literals)
  self.assertNotIn('\\n',literals)
  self.assertNotIn(b'\\n',literals)
 def test_invalid_worker_sha_fails_closed(self):
  with tempfile.TemporaryDirectory() as tmp:
   tree=pathlib.Path(tmp)/'invalid';worker=tree/'dist/cli/repository-write-worker.js';worker.parent.mkdir(parents=True);worker.write_text('test')
   with self.assertRaisesRegex(RuntimeError,'release SHA invalid'):d.worker_pin(tree)
unittest.main(verbosity=2)
`;
const result=spawnSync("python3",["-B","-c",python],{encoding:"utf8"});
assert.equal(result.status,0,result.stderr);
console.log("Deployment transaction regression: PASS (legacy rollback, worker failure, SHA pin)");
