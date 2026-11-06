import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SECURITY_PROJECT, isolatedChildEnvironment} from './isolation.mjs';

// No caller-supplied command, target, or deployment option is accepted.
if (process.argv.length !== 2) throw new Error('Security runner accepts no arguments');
const root = fileURLToPath(new URL('../', import.meta.url));
const env = isolatedChildEnvironment();
function run(executable, args, timeout) {
  const result = spawnSync(executable, args, {cwd: root, env, stdio: 'inherit', timeout});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--prefix', 'functions'], 60000);
run(process.execPath, ['node_modules/firebase-tools/lib/bin/firebase.js',
  '--config', 'firebase.security.json', '--project', SECURITY_PROJECT,
  'emulators:exec', '--only', 'firestore', 'node security/suite.mjs'], 240000);
