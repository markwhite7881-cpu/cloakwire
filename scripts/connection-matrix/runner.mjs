import { spawn } from 'node:child_process';
import { once } from 'node:events';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const EMPTY = { pid: null, exitCode: null, stdout: '', stderr: '' };

// This helper owns only the process it spawned (and its descendants). It never
// finds or terminates processes by name; production VPN cores are unrelated.
export function startOwnedProcess(file, args, { timeoutMs = 12000, maxOutputBytes = 4096, signal, cwd } = {}) {
  if (signal?.aborted) return { pid: null, done: Promise.resolve({ ...EMPTY, issue: 'cancelled' }), stop: async () => {} };
  const child = spawn(file, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
    const remaining = Math.max(0, maxOutputBytes - chunks[stream].length);
    if (remaining) chunks[stream] = Buffer.concat([chunks[stream], data.subarray(0, remaining)]);
  });
  let issue = null, stopPromise, settle;
  const done = new Promise(resolve => { settle = resolve; });
  let finished = false;
  const finish = exitCode => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    settle({ pid: child.pid ?? null, exitCode, issue: issue ?? (exitCode === 0 ? null : 'core_rejected'), stdout: chunks.stdout.toString(), stderr: chunks.stderr.toString() });
  };
  const stop = (reason = 'cancelled') => {
    if (stopPromise) return stopPromise;
    if (finished) return Promise.resolve();
    issue = reason;
    stopPromise = (async () => {
      // Never issue a PID-tree kill after observing this owner's exit.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          await Promise.race([once(killer, 'close').catch(() => {}), delay(1800)]);
          if (killer.exitCode === null) killer.kill();
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await Promise.race([done, delay(2000)]);
      if (!finished) {
        issue = 'cleanup_failed';
        child.stdout.destroy(); child.stderr.destroy();
        finish(null);
      }
    })();
    return stopPromise;
  };
  const abort = () => { void stop('cancelled'); };
  const timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
  child.once('error', () => { issue = 'engine_unavailable'; finish(null); });
  child.once('close', code => finish(code));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { pid: child.pid ?? null, done, stop };
}

export async function runOwnedProcess(file, args, options) {
  return startOwnedProcess(file, args, options).done;
}

const loopback = value => value === '127.0.0.1' || value === '::1';
export function assertLoopbackFixture(config) {
  const unsafe = () => { throw new Error('unsafe_fixture'); };
  if (config.log?.output || config.log?.access || config.log?.error || config.experimental || config.api) unsafe();
  for (const inbound of config.inbounds ?? []) {
    if (!loopback(inbound.listen) || !['mixed', 'socks', 'http', 'vless'].includes(inbound.type ?? inbound.protocol)) unsafe();
  }
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['server', 'address'].includes(key) && typeof child === 'string' && !loopback(child)) unsafe();
      if (['auto_route', 'strict_route', 'auto_redirect'].includes(key) && child) unsafe();
      if (key === 'type' && ['tun', 'tproxy', 'redirect'].includes(child)) unsafe();
      if (key === 'protocol' && ['tun', 'dokodemo-door'].includes(child)) unsafe();
      visit(child);
    }
  };
  visit(config);
  return config;
}
