// The IPC lease ties the runtime lifetime to its transaction controller.
// Controller SIGKILL also closes IPC, so its candidate cannot become an orphan.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
let child;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
  process.exit(0);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', message => {
  if (message.type === 'stop') { void stop(); return; }
  if (message.type !== 'start' || child || stopping) return;
  if (process.platform === 'win32') {
    child = spawn('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./windows-contained-process.ps1', import.meta.url))], {
      cwd: message.root, windowsHide: true, stdio: ['pipe','ignore','pipe'],
    });
    const lines = readline.createInterface({ input: child.stderr });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; } // Runtime stderr is not control metadata.
      if (event.containment === 'ready') process.send?.({ type: 'started', pid: event.pid, containmentPid: event.hostPid });
    });
    child.stdin.on('error', () => { void stop(); });
    child.stdin.write(JSON.stringify({ executable: process.execPath, arguments: ['--enable-source-maps', message.entry], cwd: message.root, env: message.env, memoryBytes: message.memoryBytes ?? 0 })+'\n');
  } else {
    child = spawn(process.execPath, ['--enable-source-maps', message.entry], {
      cwd: message.root, env: message.env, windowsHide: true, stdio: 'ignore',
    });
    child.once('spawn', () => process.send?.({ type: 'started', pid: child.pid }));
  }
  child.once('error', () => { process.send?.({ type: 'failed' }); void stop(); });
  child.once('exit', (code, signal) => {
    if (!stopping) { process.send?.({ type: 'exited', code, signal }); process.exit(1); }
  });
});
