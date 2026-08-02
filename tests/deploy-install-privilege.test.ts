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
  executable(join(bin, 'npm'), `#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf '%s\\n' "$*" > ${JSON.stringify(join(trace, 'npm-args'))}\nid -u > ${JSON.stringify(join(trace, 'npm-euid'))}\nstat -c %a . > ${JSON.stringify(join(trace, 'mode-during-install'))}\nenv | sort > ${JSON.stringify(join(trace, 'npm-env'))}\ntouch .lifecycle-ran\nexit ${npmExit}\n`);

  const result = spawnSync('/usr/bin/bash', ['-c', 'source scripts/deploy.sh; install_production_dependencies "$TARGET_RELEASE" "$(id -un)" "$INSTALL_PATH" "$RUNUSER" "$CHOWN"'], {
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
    },
  });

  return { result, release, trace };
}

describe('deploy dependency install privilege (A15)', () => {
  it('runs lifecycle install once as the delegated user with an empty allowlisted environment', () => {
    const { result, release, trace } = runInstall();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(trace, 'runuser-args'), 'utf8')).toContain(`-u ${process.env.USER ?? ''} --`);
    expect(readFileSync(join(trace, 'npm-args'), 'utf8').trim()).toBe('ci --omit=dev --ignore-scripts=false --no-audit --no-fund');
    expect(Number(readFileSync(join(trace, 'npm-euid'), 'utf8').trim())).toBe(process.getuid?.());
    expect(readFileSync(join(trace, 'mode-during-install'), 'utf8').trim()).toBe('770');
    const environment = readFileSync(join(trace, 'npm-env'), 'utf8');
    expect(environment).not.toContain('SECRET_SENTINEL');
    expect(environment).not.toContain('NPM_CONFIG_REGISTRY');
    expect(environment).toContain(`HOME=${join(release, '.npm-home')}`);
    expect(environment).toContain(`npm_config_cache=${join(release, '.npm-cache')}`);
    expect(statSync(release).mode & 0o777).toBe(0o750);
    expect(() => statSync(join(release, '.npm-home'))).toThrow();
    expect(() => statSync(join(release, '.npm-cache'))).toThrow();
    expect(statSync(join(release, '.lifecycle-ran')).isFile()).toBe(true);
  });

  it('restores locked permissions and removes npm state when lifecycle install fails', () => {
    const { result, release } = runInstall(42);
    expect(result.status).toBe(42);
    expect(statSync(release).mode & 0o777).toBe(0o750);
    expect(() => statSync(join(release, '.npm-home'))).toThrow();
    expect(() => statSync(join(release, '.npm-cache'))).toThrow();
  });
});
