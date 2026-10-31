import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOwnedProcess } from './runner.mjs';
test('system suite cannot run implicitly or without a dedicated adapter', async () => {
  const result = await runOwnedProcess(process.execPath, ['scripts/test-connection-matrix.mjs', '--suite', 'system']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /system_suite_requires_dedicated_runner/);
});
test('unknown CLI arguments fail closed', async () => {
  const result = await runOwnedProcess(process.execPath, ['scripts/test-connection-matrix.mjs', '--arbitrary', 'SECRET']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr.includes('SECRET'), false);
});
