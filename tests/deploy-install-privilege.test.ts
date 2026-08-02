import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deploy = readFileSync('scripts/deploy.sh', 'utf8');

describe('deploy dependency install privilege (A15)', () => {
  it('installs production dependencies exactly once', () => {
    const npmCiLines = deploy
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && line.includes('npm ci'));
    expect(npmCiLines).toHaveLength(1);
  });

  it('delegates npm ci to the unprivileged service user, never root', () => {
    // better-sqlite3 has an install script that compiles a native binding, so
    // `npm ci` runs package lifecycle scripts. Running that as root would let
    // any dependency execute arbitrary code with full privileges during deploy.
    // The install must be handed to the same unprivileged service user the
    // preflight already uses, so the binding still builds but not as root.
    expect(deploy).toMatch(
      /runuser --preserve-environment -u "\$SERVICE" -- \\\n\s*bash -c '[^\n]*npm ci[^\n]*'/,
    );
  });

  it('does not run npm ci inside a bare root subshell', () => {
    expect(deploy).not.toMatch(/cd "\$RELEASE"\s*\n\s*npm ci/);
  });

  it('keeps lifecycle scripts enabled so the native binding still builds', () => {
    expect(deploy).toContain('--ignore-scripts=false');
  });
});
