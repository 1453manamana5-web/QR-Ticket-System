import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertIsolatedEnvironment} from './isolation.mjs';

assertIsolatedEnvironment();
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(new URL('./', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => 'security/' + name);
if (!tests.length) throw new Error('No security tests found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
  cwd: root, env: process.env, stdio: 'inherit', timeout: 180000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
