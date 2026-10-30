#!/usr/bin/python3
"""POSIX deployment contract tests; no system services or production paths are changed."""
import sys
if not sys.flags.isolated:
    raise SystemExit('Use python3 -I')
import fcntl
import hashlib
import http.server
import json
import multiprocessing
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
D = runpy.run_path(str(HERE / 'deploy.py'), run_name='deployment_test')
G = runpy.run_path(str(HERE / 'gates.py'), run_name='gate_test')
P = runpy.run_path(str(HERE / 'prepare.py'), run_name='preparation_test')


def contender(path, result):
    with open(path, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result.put('acquired')
        except BlockingIOError:
            result.put('denied')


class DeploymentContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='console-deployment-contract-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        (self.base / 'releases').mkdir()
        self.sha = 'a' * 40
        self.reg = dict(candidate=self.sha, rollback='previous', sourceSHA=self.sha)
        for name in (self.sha, 'previous'):
            (self.base / 'releases' / name).mkdir()
        self.globals = D['apply'].__globals__
        self.patch = patch.dict(self.globals, BASE=self.base)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.actions = []

    def verify(self, tree):
        self.actions.append(('verify', tree.name))
        return {'sourceCommit': self.sha}

    def restart(self, tree):
        self.actions.append(('restart', tree.name))

    def gates(self, command, **kwargs):
        mode = command[-1]
        self.actions.append(('gate', mode))
        if mode == getattr(self, 'fail', None):
            raise subprocess.CalledProcessError(1, command)

    def execute(self, function):
        with patch.dict(self.globals, verify=self.verify, restart=self.restart), patch.object(subprocess, 'run', self.gates):
            function(self.reg)

    def test_successful_activation(self):
        self.execute(D['apply'])
        self.assertEqual(json.loads((self.base / 'transaction.json').read_text())['phase'], 'committed')
        self.assertEqual([a for a in self.actions if a[0] != 'verify'],
                         [('gate', 'pre'), ('restart', self.sha), ('gate', 'post')])

    def test_failed_activation_rolls_back(self):
        self.fail = 'post'
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(D['apply'])
        self.assertIn(('restart', 'previous'), self.actions)
        self.assertFalse((self.base / 'transaction.json').exists())
        self.assertEqual(len(list(self.base.glob('rollback-receipt-*.json'))), 1)

    def test_pre_gate_failure_never_mutates_production(self):
        self.fail = 'pre'
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(D['apply'])
        self.assertFalse(any(a[0] == 'restart' for a in self.actions))
        self.assertFalse((self.base / 'transaction.json').exists())

    def test_interrupted_activation_recovers_once(self):
        (self.base / 'transaction.json').write_text(json.dumps(dict(phase='pending', rollback='previous')))
        self.execute(D['recover'])
        self.execute(D['recover'])
        self.assertEqual(self.actions.count(('restart', 'previous')), 1)

    def test_process_death_leaves_recoverable_durable_journal(self):
        script = ('import os,runpy,pathlib\n'
                  f'd=runpy.run_path({str(HERE / "deploy.py")!r});g=d["apply"].__globals__\n'
                  f'g["BASE"]=pathlib.Path({str(self.base)!r})\n'
                  f'g["verify"]=lambda tree:{{"sourceCommit":{self.sha!r}}}\n'
                  'g["subprocess"].run=lambda *a,**kw:None\n'
                  'g["restart"]=lambda tree:os._exit(9)\n'
                  f'd["apply"]({self.reg!r})\n')
        result = subprocess.run([sys.executable, '-I', '-c', script], timeout=10)
        self.assertEqual(result.returncode, 9)
        state = json.loads((self.base / 'transaction.json').read_text())
        self.assertEqual((state['phase'], state['rollback']), ('pending', 'previous'))
        self.execute(D['recover'])
        self.assertEqual(self.actions.count(('restart', 'previous')), 1)

    def test_terminal_journals_do_not_restart(self):
        for phase in ('committed', 'rolled_back'):
            (self.base / 'transaction.json').write_text(json.dumps(dict(phase=phase)))
            self.execute(D['recover'])
        self.assertEqual(self.actions, [])

    def test_pending_rollback_cannot_be_retargeted(self):
        (self.base / 'transaction.json').write_text(json.dumps(dict(phase='pending', rollback='other')))
        with self.assertRaisesRegex(RuntimeError, 'conflicts'):
            self.execute(D['recover'])
        self.assertEqual(self.actions, [])

    def test_paths_and_source_attestation_fail_closed(self):
        for value in ('../elsewhere', '/etc', '.', '..', 'a/b'):
            with self.assertRaises(RuntimeError):
                D['release']({'candidate': value}, 'candidate')
        self.reg['sourceSHA'] = 'b' * 40
        with self.assertRaisesRegex(RuntimeError, 'source identity'):
            self.execute(D['apply'])
        self.assertFalse(any(a[0] == 'restart' for a in self.actions))

    def test_seal_detects_content_tampering(self):
        tree = self.base / 'releases' / self.sha
        content = tree / 'payload'
        content.write_bytes(b'original')
        manifest = tree / 'release.json'
        manifest.write_text(json.dumps({'files': {'payload': hashlib.sha256(b'original').hexdigest()}}))
        # The real root ownership gate is tested when the operator seals the release.
        # An unprivileged test cannot pretend its fixture has root ownership.
        if os.geteuid() == 0:
            D['verify'](tree)
            content.write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'hash mismatch'):
                D['verify'](tree)
        else:
            with self.assertRaisesRegex(RuntimeError, 'unsealed'):
                D['verify'](tree)

    def test_concurrent_attempt_is_denied_by_real_posix_lock(self):
        context = multiprocessing.get_context('fork')
        result = context.Queue()
        with (self.base / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            process = context.Process(target=contender, args=(str(self.base / 'lock'), result))
            process.start()
            try:
                self.assertEqual(result.get(timeout=5), 'denied')
            finally:
                process.join(5)
                if process.is_alive():
                    process.terminate(); process.join()
            self.assertEqual(process.exitcode, 0)

    def test_dynamic_exact_browser_baseline(self):
        snapshot = {'windows': [['one', 42], ['two', 42]],
                    'cdp': {'9224': {'targets': [[str(i), 'page'] for i in range(17)]}}}
        processes = {'9224': {'pid':42,'startTicks':'123','uid':1000}}
        (self.base / 'browser-baseline.json').write_text(json.dumps(snapshot))
        (self.base / 'browser-processes.json').write_text(json.dumps(processes))
        with patch.dict(G['verify_browser_snapshot'].__globals__, B=self.base, browser=lambda:snapshot, browser_processes=lambda:processes):
            reg = dict(expectedWindowCount=2, expectedPageCount=17)
            G['verify_browser_snapshot'](reg)
            snapshot['cdp']['9224']['targets'].pop()
            with self.assertRaisesRegex(AssertionError, 'identity drift'):
                G['verify_browser_snapshot'](reg)

    def test_preparation_rejects_pending_transaction(self):
        (self.base / 'transaction.json').write_text('{"phase":"pending"}')
        with patch.dict(P['check_pending'].__globals__, B=self.base):
            with self.assertRaisesRegex(RuntimeError, 'Recover'):
                P['check_pending']()

    def test_preparation_uses_loaded_binding_instead_of_old_registry(self):
        loaded = self.base / 'releases' / 'previous'
        with patch.dict(P['current_release'].__globals__, B=self.base):
            result = P['current_release']({'show':lambda *args:str(loaded / 'dist') + ':' + str(P['L'] / 'dist')})
            self.assertEqual(result, loaded)
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                P['current_release']({'show':lambda *args:''})


class AuthenticatedTransport(unittest.TestCase):
    def request(self, mode):
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body['method'])
                if mode == 'redirect':
                    self.send_response(307); self.send_header('Location', '/redirected'); self.end_headers(); return
                if body['method'] == 'initialize':
                    data = json.dumps({'result':{'protocolVersion':'2024-11-05'}}).encode()
                    kind = 'application/json'
                elif body['method'] == 'notifications/initialized':
                    self.send_response(202); self.end_headers(); return
                elif mode == 'oversize':
                    data = b'x' * 1048577; kind = 'application/json'
                else:
                    data = ('data: ' + json.dumps({'result':{'content':[{'type':'text','text':'{"ok":true}'}]}}) + '\n\n').encode()
                    kind = 'text/event-stream'
                self.send_response(200); self.send_header('Content-Type',kind)
                self.send_header('Content-Length',str(len(data))); self.end_headers()
                try:self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            with patch.dict(G['rpc'].__globals__, env=lambda pid:{'CONSOLE_MCP_BEARER_TOKEN':'synthetic-fixture-only'}), patch.dict(os.environ, HTTP_PROXY='http://127.0.0.1:1', NO_PROXY=''):
                return G['rpc'](123, server.server_port, 'read_.system.console.health'), requests
        finally:
            server.shutdown(); server.server_close(); worker.join(3)

    def test_negotiated_sse_and_proxy_isolation(self):
        value, requests = self.request('sse')
        self.assertEqual(value, {'ok':True})
        self.assertEqual(requests, ['initialize','notifications/initialized','tools/call'])

    def test_response_size_limit(self):
        with self.assertRaisesRegex(RuntimeError, 'size limit'):
            self.request('oversize')

    def test_authenticated_redirect_is_refused(self):
        import urllib.error
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('redirect')
        self.assertEqual(error.exception.code, 307)


if __name__ == '__main__':
    unittest.main(verbosity=2)
