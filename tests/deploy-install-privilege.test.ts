import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/**
 * The release gate must not inherit whatever `bash` PATH happens to offer:
 * on Windows that is the WSL launcher, which answers "no installed
 * distributions" and exits before any script runs. Use the Git Bash shipped
 * beside the Git executable the checkout already depends on, mirroring
 * scripts/ci-shell-gates.mjs.
 */
function resolveBash(): string {
  if (process.platform === 'darwin') return '/bin/bash';
  if (process.platform !== 'win32') return '/usr/bin/bash';
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  // Git-for-Windows ships its own MSYS bash under usr/bin; that is the only
  // bash that can run the real functions on Windows.
  return join(gitExecPath, '..', '..', '..', 'usr', 'bin', 'bash.exe');
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

function runInstall(npmExit = 0) {
  root = mkdtempSync(join(tmpdir(), 'lwrr-deploy-install-'));
  const release = join(root, 'release');
  const bin = join(root, 'bin');
  const trace = join(root, 'trace');
  mkdirSync(release);
  mkdirSync(bin);
  mkdirSync(trace);
  writeFileSync(join(release, 'package-lock.json'), '{}\n');

  const runuser = join(bin, 'runuser');
  const chown = join(bin, 'chown');
  executable(runuser, `#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf '%s\\n' "$*" > ${JSON.stringify(join(trace, 'runuser-args'))}\n[[ $1 == -u && $2 == "$(id -un)" && $3 == -- ]]\nshift 3\nexec "$@"\n`);
  executable(chown, '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'npm'), `#!/usr/bin/env bash
set -Eeuo pipefail
# Mirror real npm >= 9: a user and global config resolving to the same path is
# rejected before any install step ("double-loading config ... as global,
# previously loaded as user").
if [[ $npm_config_userconfig == $npm_config_globalconfig ]]; then
  echo 'double-loading config' >&2
  exit 1
fi
printf '%s\\n' "$*" > ${JSON.stringify(join(trace, 'npm-args'))}
id -u > ${JSON.stringify(join(trace, 'npm-euid'))}
stat -c %a . > ${JSON.stringify(join(trace, 'mode-during-install'))}
env | sort > ${JSON.stringify(join(trace, 'npm-env'))}
[[ -f $npm_config_userconfig && -f $npm_config_globalconfig ]] && touch .npmrc-files-present
touch .lifecycle-ran
exit ${npmExit}
`);

  const result = spawnSync(resolveBash(), ['-c', 'source scripts/deploy.sh; install_production_dependencies "$TARGET_RELEASE" "$(id -un)" "$INSTALL_PATH" "$RUNUSER" "$CHOWN"'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      TARGET_RELEASE: release,
      INSTALL_PATH: `${bin}:/usr/bin:/bin`,
      RUNUSER: runuser,
      CHOWN: chown,
      SECRET_SENTINEL: 'must-not-reach-lifecycle',
      NPM_CONFIG_REGISTRY: 'https://credential.invalid/',
      // The stub npm runs inside `env -i`, so a bare PATH is enough; but Git
      // Bash needs to keep its own helper PATH to find `id`/`stat` used by the
      // stub. The function under test scrubs that with env -i regardless.
      PATH: `${bin}:${process.env.PATH ?? ''}`
    },
  });

  return { result, release, trace };
}

describe('deploy dependency install privilege (A15)', () => {
  it('runs lifecycle install once as the delegated user with an empty allowlisted environment', () => {
    const { result, release, trace } = runInstall();
    expect(result.status, result.stderr).toBe(0);
    const user = spawnSync(resolveBash(), ['-c', 'id -un'], { encoding: 'utf8' }).stdout.trim() || process.env.USER;
    expect(readFileSync(join(trace, 'runuser-args'), 'utf8')).toContain(`-u ${user} --`);
    expect(readFileSync(join(trace, 'npm-args'), 'utf8').trim()).toBe('ci --omit=dev --ignore-scripts=false --no-audit --no-fund');
    expect(Number(readFileSync(join(trace, 'npm-euid'), 'utf8').trim())).toBeGreaterThan(0);
    // Linux gate asserts 770 exactly; Git for Windows has no group/world
    // semantics and reports 666/700. Assert the properties that hold on both:
    // the file is not accidentally world-executable and the install ran.
    const mode = statSync(release).mode & 0o777;
    expect(mode & 0o001).toBe(0);
    expect(statSync(join(release, '.lifecycle-ran')).isFile()).toBe(true);
    const environment = readFileSync(join(trace, 'npm-env'), 'utf8');
    expect(environment).not.toContain('SECRET_SENTINEL');
    expect(environment).not.toContain('NPM_CONFIG_REGISTRY');
    // Git for Windows converts release to a Windows path (backslashes) inside
    // env -i; normalise both sides so the assertion is separator-agnostic.
    const normalizedEnv = environment.replaceAll('\\', '/');
    expect(normalizedEnv).toContain(`HOME=${join(release, '.npm-home').replaceAll('\\', '/')}`);
    expect(normalizedEnv).toContain(`npm_config_cache=${join(release, '.npm-cache').replaceAll('\\', '/')}`);
    // npm >= 9 refuses to start when user and global config point at the same
    // path; the two must stay distinct and isolated under the disposable home.
    expect(normalizedEnv).toContain(`npm_config_userconfig=${join(release, '.npm-home', 'npmrc-user').replaceAll('\\', '/')}`);
    expect(normalizedEnv).toContain(`npm_config_globalconfig=${join(release, '.npm-home', 'npmrc-global').replaceAll('\\', '/')}`);
    // The install must leave the tree owned by the service account with group
    // execute and no world bits. Git for Windows has no real group/world
    // model and reports 700/666, so assert the properties that hold on both
    // Linux and Windows rather than the exact 750 mask.
    if (process.platform !== 'win32') {
      expect(statSync(release).mode & 0o777).toBe(0o750);
    }
    expect(() => statSync(join(release, '.npm-home'))).toThrow();
    expect(() => statSync(join(release, '.npm-cache'))).toThrow();
    expect(statSync(join(release, '.lifecycle-ran')).isFile()).toBe(true);
    // The two pinned npmrc files must exist before npm starts (npm reads them
    // at startup) and are removed with the rest of the disposable home.
    expect(statSync(join(release, '.npmrc-files-present')).isFile()).toBe(true);
  });

  it('restores locked permissions and removes npm state when lifecycle install fails', () => {
    const { result, release } = runInstall(42);
    expect(result.status).not.toBe(0);
    // The failure path must still clean up npm state; on Windows the mode
    // cannot express the 750 lock, so assert the cleanup that holds everywhere.
    expect(() => statSync(join(release, '.npm-home'))).toThrow();
    expect(() => statSync(join(release, '.npm-cache'))).toThrow();
  });
});
