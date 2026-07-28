import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The release gate must not inherit whatever `bash` PATH happens to offer:
 * on Windows that is the WSL launcher, which answers "no installed
 * distributions" and exits before any script runs. Use the Git Bash shipped
 * beside the Git executable the checkout already depends on.
 */
function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const candidate = resolve(gitExecPath, '..', '..', '..', 'bin', 'bash.exe');
  if (!existsSync(candidate)) {
    throw new Error(`Git Bash executable not found beside git exec path: ${candidate}`);
  }
  return candidate;
}

function run(step, command, args) {
  console.log(`\n=== ${step} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${step} failed with exit code ${result.status}`);
}

const bash = resolveBash();
console.log(`bash=${bash}`);

const entries = await readdir('scripts', { withFileTypes: true });
const shellFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
  .map((entry) => `scripts/${entry.name}`);
if (shellFiles.length === 0) throw new Error('no shell scripts found under scripts/');

run('shell syntax', bash, ['-n', ...shellFiles]);

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
run('package immutable release', bash, ['scripts/build-release.sh', sha]);
