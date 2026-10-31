const issues = new Set(['timeout', 'cancelled', 'engine_unavailable', 'core_rejected', 'cleanup_failed', 'unexpected_result', 'unsafe_fixture']);
const names = new Set(['valid-config', 'malformed-config', 'vless-loopback', 'wrong-user', 'reality-valid', 'reality-wrong-key']);
export function publicCase(name, engine, result, expectedExit = 0) {
  const passed = result.issue !== 'timeout' && result.issue !== 'engine_unavailable' && result.issue !== 'cancelled' && result.issue !== 'cleanup_failed' &&
    (expectedExit === 'nonzero' ? Number.isInteger(result.exitCode) && result.exitCode !== 0 : result.exitCode === expectedExit);
  return {
    case: names.has(name) ? name : 'unknown',
    engine: ['sing-box', 'xray'].includes(engine) ? engine : 'unknown',
    platform: process.platform,
    architecture: process.arch,
    status: passed ? 'passed' : 'failed',
    issue: passed ? null : issues.has(result.issue) ? result.issue : 'unexpected_result',
  };
}
