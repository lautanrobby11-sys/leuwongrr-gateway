import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let release: string | undefined;

afterEach(() => {
  if (release) rmSync(release, { recursive: true, force: true });
  release = undefined;
});

/**
 * The release gate must not inherit whatever `bash` PATH happens to offer:
 * on Windows that is the WSL launcher, which answers "no installed
 * distributions" and exits before any script runs. Use the Git Bash shipped
 * beside the Git executable the checkout already depends on, mirroring
 * scripts/ci-shell-gates.mjs.
 */
function resolveBash(): string {
  if (process.platform !== 'win32') return '/usr/bin/bash';
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  return join(gitExecPath, '..', '..', '..', 'usr', 'bin', 'bash.exe');
}

function createRelease(): string {
  release = mkdtempSync(join(tmpdir(), 'lwrr-rollback-manifest-'));
  writeFileSync(join(release, 'app.js'), 'trusted release\n');
  const digest = spawnSync(resolveBash(), ['-c', 'sha256sum app.js'], { cwd: release, encoding: 'utf8' });
  expect(digest.status, digest.stderr).toBe(0);
  writeFileSync(join(release, 'manifest.sha256'), digest.stdout);
  return release;
}

function verify(target: string) {
  return spawnSync(resolveBash(), ['-c', 'source scripts/rollback.sh; verify_release_manifest "$TARGET"'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TARGET: target },
  });
}

describe('rollback target manifest verification (A18)', () => {
  it('accepts an intact release before activation', () => {
    const result = verify(createRelease());
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a release whose content changed after deployment', () => {
    const target = createRelease();
    writeFileSync(join(target, 'app.js'), 'tampered release\n');
    const result = verify(target);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('rollback target manifest verification failed');
    expect(readFileSync(join(target, 'app.js'), 'utf8')).toBe('tampered release\n');
  });

  it('rejects a release with no manifest', () => {
    const target = createRelease();
    rmSync(join(target, 'manifest.sha256'));
    const result = verify(target);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('rollback target manifest.sha256 is missing');
  });
});
