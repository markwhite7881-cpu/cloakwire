import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedProcess, assertLoopbackFixture } from './runner.mjs';
import { publicCase } from './report.mjs';

test('report never copies output, arguments or unknown error text', async () => {
  const result = await runOwnedProcess(process.execPath, ['-e', 'console.error("SECRET-SENTINEL");process.exit(9)']);
  const report = publicCase('malformed-config', 'xray', result);
  assert.equal(report.status, 'failed');
  assert.equal(report.issue, 'core_rejected');
  assert.equal(JSON.stringify(report).includes('SECRET-SENTINEL'), false);
  assert.equal(JSON.stringify(publicCase('valid-config', 'sing-box', { ...result, issue: 'SECRET-SENTINEL' })).includes('SECRET-SENTINEL'), false);
});

test('timeout kills owned descendants while an unrelated process survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cw-matrix-test-'));
  const heartbeat = join(dir, 'heartbeat');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const childCode = `const fs=require('node:fs'); setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20)`;
    const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{windowsHide:true,stdio:'ignore'}); setInterval(()=>{},1000)`;
    const result = await runOwnedProcess(process.execPath, ['-e', parentCode], { timeoutMs: 1200 });
    assert.equal(result.issue, 'timeout');
    const stopped = await readFile(heartbeat, 'utf8');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await readFile(heartbeat, 'utf8'), stopped);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    unrelated.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancellation before launch never creates a child', async () => {
  const result = await runOwnedProcess('does-not-exist', [], { signal: AbortSignal.abort() });
  assert.equal(result.issue, 'cancelled');
  assert.equal(result.pid, null);
});

test('output is bounded and missing binary has a safe issue', async () => {
  const noisy = await runOwnedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { maxOutputBytes: 128 });
  assert.ok(Buffer.byteLength(noisy.stdout) <= 128);
  const missing = await runOwnedProcess('cloakwire-fixture-no-such-binary', []);
  assert.equal(missing.issue, 'engine_unavailable');
});

test('core suite rejects system listeners and external destinations before launch', () => {
  assert.doesNotThrow(() => assertLoopbackFixture({ inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 12000 }], outbounds: [{ type: 'direct' }] }));
  for (const config of [
    { inbounds: [{ type: 'tun' }] },
    { inbounds: [{ protocol: 'socks', listen: '0.0.0.0' }] },
    { outbounds: [{ type: 'vless', server: 'public.example', server_port: 443 }] },
    { log: { output: 'active.log' } },
    { experimental: { clash_api: { external_controller: '127.0.0.1:9090' } } },
  ]) assert.throws(() => assertLoopbackFixture(config), /unsafe_fixture/);
});
