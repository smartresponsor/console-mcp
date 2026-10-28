// The IPC lease ties the runtime lifetime to its transaction controller.
// Controller SIGKILL also closes IPC, so its candidate cannot become an orphan.
import { spawn } from 'node:child_process';
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
  child = spawn(process.execPath, ['--enable-source-maps', message.entry], {
    cwd: message.root, env: message.env, windowsHide: true, stdio: 'ignore',
  });
  child.once('spawn', () => process.send?.({ type: 'started', pid: child.pid }));
  child.once('error', () => { process.send?.({ type: 'failed' }); void stop(); });
  child.once('exit', (code, signal) => {
    if (!stopping) { process.send?.({ type: 'exited', code, signal }); process.exit(1); }
  });
});
