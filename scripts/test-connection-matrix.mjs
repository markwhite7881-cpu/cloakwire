import { parseArgs } from 'node:util';
import { runMatrix } from './connection-matrix/matrix.mjs';

try {
  const { values } = parseArgs({ options: { suite: { type: 'string', default: 'core' }, binaries: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (values.suite === 'system') throw new Error('system_suite_requires_dedicated_runner');
  if (values.suite !== 'core' || !values.binaries || !values.output) throw new Error('invalid_arguments');
  const report = await runMatrix(values);
  console.log(JSON.stringify({ suite: report.suite, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status !== 'passed').length }));
  process.exitCode = report.cases.every(c => c.status === 'passed') ? 0 : 1;
} catch (error) {
  // Never echo paths, CLI arguments, core stderr or fixture credentials.
  console.error(['system_suite_requires_dedicated_runner', 'unsupported_platform'].includes(error.message) ? error.message : 'matrix_setup_failed');
  process.exitCode = 2;
}
