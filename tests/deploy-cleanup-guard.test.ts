import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitBashEnv, resolveGitBash } from './support/git-bash.js';

function resolveBash(): string {
  return resolveGitBash();
}

const bash = resolveBash();

/**
 * The cleanup_failed_release trap must only delete a release directory that
 * this session created.  If the guard at line 199
 *   [[ ! -e $RELEASE ]] || fail 'immutable release already exists'
 * triggers because the directory already exists from a previous deploy, the
 * trap must not delete it.
 *
 * Regression: incident 13 Aug 2026 17:07Z — deploy.sh with SHA cc93a86b...
 * hit the immutable guard, and the trap deleted the pre-existing release
 * directory that belonged to a prior attempt of the same SHA.
 */
describe('deploy cleanup trap (immutable release guard)', () => {
  it('does not delete a pre-existing release directory when the guard fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwrr-cleanup-guard-'));
    try {
      const releaseDir = join(root, 'releases', 'deadbeef');
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, 'marker'), 'pre-existing');

      const script = [
        'set -Eeuo pipefail',
        'source scripts/deploy.sh',
        `ROOT=${JSON.stringify(root)}`,
        `RELEASE=${JSON.stringify(releaseDir)}`,
        'ACTIVATED=0',
        // Simulate the guard failure: the release dir already exists.
        '[[ ! -e $RELEASE ]] || fail "immutable release already exists"',
      ].join('\n');

      const result = spawnSync(bash, ['-c', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: gitBashEnv(),
      });

      // The script must fail at the guard.
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/immutable release already exists/);

      // The pre-existing release directory must survive.
      expect(existsSync(join(releaseDir, 'marker'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes a session-created release directory when the deploy fails before activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwrr-cleanup-guard-'));
    try {
      const releaseDir = join(root, 'releases', 'cafebabe');
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, 'marker'), 'session-created');

      const script = [
        'set -Eeuo pipefail',
        'source scripts/deploy.sh',
        `ROOT=${JSON.stringify(root)}`,
        `RELEASE=${JSON.stringify(releaseDir)}`,
        'ACTIVATED=0',
        // Mark the release as created by this session (simulating the fix).
        'CREATED_RELEASE=1',
        // Simulate a failure after the release was created.
        'fail "something went wrong during deploy"',
      ].join('\n');

      const result = spawnSync(bash, ['-c', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: gitBashEnv(),
      });

      expect(result.status).toBe(1);
      // The session-created release directory must be cleaned up.
      expect(existsSync(releaseDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});