import { createServer as tcpServer, connect } from 'node:net';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runOwnedProcess, startOwnedProcess, assertLoopbackFixture } from './runner.mjs';
import { checkArgs, runArgs, loopbackFixtures } from './fixtures.mjs';
import { publicCase } from './report.mjs';

async function freePort() {
  const server = tcpServer();
  await new Promise((yes, no) => server.once('error', no).listen(0, '127.0.0.1', yes));
  const port = server.address().port;
  await new Promise(yes => server.close(yes));
  return port;
}
async function ready(port, owner) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const connected = await new Promise(yes => {
      const socket = connect({ host: '127.0.0.1', port });
      const finish = ok => { socket.destroy(); yes(ok); };
      socket.once('connect', () => finish(true)).once('error', () => finish(false));
      socket.setTimeout(150, () => finish(false));
    });
    if (connected) return;
    const dead = await Promise.race([owner.done.then(() => true), new Promise(r => setTimeout(() => r(false), 30))]);
    if (dead) throw new Error('core_rejected');
  }
  throw new Error('timeout');
}
async function proxyRequest(proxyPort, targetPort) {
  return new Promise(resolveRequest => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://127.0.0.1:${targetPort}/fixture`, agent: false }, response => {
      response.resume();
      resolveRequest(response.statusCode === 204);
    });
    req.setTimeout(1500, () => req.destroy());
    req.once('error', () => resolveRequest(false));
    req.end();
  });
}
async function loopbackCase(engine, binaries, dir, wrongUser) {
  const owners = [];
  let hits = 0;
  const target = createServer((_, response) => { hits++; response.writeHead(204).end(); });
  await new Promise((yes, no) => target.once('error', no).listen(0, '127.0.0.1', yes));
  try {
    const serverPort = await freePort(), proxyPort = await freePort();
    const fixtures = loopbackFixtures({ serverPort, proxyPort, wrongUser });
    for (const [label, core, config, port] of [
      ['server', 'xray', fixtures.server, serverPort],
      ['client', engine, fixtures[engine], proxyPort],
    ]) {
      assertLoopbackFixture(config);
      const path = join(dir, `${label}.json`);
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      const owner = startOwnedProcess(binaries[core], runArgs(core, path));
      owners.push(owner);
      await ready(port, owner);
    }
    const success = await proxyRequest(proxyPort, target.address().port);
    const expected = wrongUser ? !success && hits === 0 : success && hits === 1;
    return { exitCode: expected ? 0 : 1, issue: expected ? null : 'unexpected_result' };
  } catch (error) {
    return { exitCode: null, issue: ['timeout', 'core_rejected'].includes(error.message) ? error.message : 'unexpected_result' };
  } finally {
    await Promise.all(owners.map(owner => owner.stop()));
    target.closeAllConnections();
    await new Promise(yes => target.close(yes));
  }
}
export async function runMatrix({ binaries: binaryDir, output }) {
  const suffix = { 'win32-x64': 'x86_64-pc-windows-msvc.exe', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin' }[`${process.platform}-${process.arch}`];
  if (!suffix) throw new Error('unsupported_platform');
  const binaries = Object.fromEntries(['sing-box', 'xray'].map(engine => [engine, resolve(binaryDir, `${engine}-${suffix}`)]));
  const coreHashes = {};
  for (const [engine, path] of Object.entries(binaries)) coreHashes[engine] = createHash('sha256').update(await readFile(path)).digest('hex');
  const git = await runOwnedProcess('git', ['rev-parse', 'HEAD']);
  const commit = /^[a-f0-9]{40}$/.test(git.stdout.trim()) ? git.stdout.trim() : null;
  const dirty = await runOwnedProcess('git', ['status', '--porcelain', '--untracked-files=no']);
  const dir = await mkdtemp(join(tmpdir(), 'cloakwire-core-matrix-'));
  const cases = [];
  try {
    for (const engine of ['sing-box', 'xray']) {
      const valid = loopbackFixtures({ serverPort: 9, proxyPort: 12001 })[engine];
      assertLoopbackFixture(valid);
      for (const [name, value, expected] of [['valid-config', JSON.stringify(valid), 0], ['malformed-config', '{"inbounds":', 'nonzero']]) {
        const file = join(dir, 'check.json');
        await writeFile(file, value, { mode: 0o600 });
        cases.push(publicCase(name, engine, await runOwnedProcess(binaries[engine], checkArgs(engine, file)), expected));
      }
      for (const wrongUser of [false, true]) cases.push(publicCase(wrongUser ? 'wrong-user' : 'vless-loopback', engine, await loopbackCase(engine, binaries, dir, wrongUser)));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  const report = { schema: 1, commit, tracked_changes: Boolean(dirty.stdout.trim()), suite: 'core', core_sha256: coreHashes, cases };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'connection-matrix.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
