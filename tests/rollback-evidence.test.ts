import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitBashEnv, resolveGitBash } from './support/git-bash.js';

/**
 * PR #69 rollback evidence hardening: the evidence append must be safe and
 * non-fatal. The original version appended to `$ROOT/logs` (owned by the
 * service account) through a root process that follows symlinks — a local
 * privilege escalation — and it put `install` outside the guarded block, so a
 * failure there aborted a rollback that had already succeeded.
 *
 * These tests source the real `scripts/rollback.sh` and invoke its
 * `record_rollback_evidence` function (so an edit is picked up, not mirrored).
 * `install -o root` would fail for the non-root test runner, so the function
 * builds the root-only directory with `mkdir -p` + `chmod 0700`, which works
 * both as root in production and as the test user here.
 */

function resolveBash(): string {
  return resolveGitBash();
}

const bash = resolveBash();

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'lwrr-rollback-evidence-'));
  return root;
}

/** Source the real rollback.sh, set the runtime globals, then run the function. */
function run(): { status: number; stdout: string; stderr: string } {
  const rootBash = root!.split('\\').join('/');
  const script = `
set -Eeuo pipefail
source scripts/rollback.sh
SERVICE=leuwongrr-gateway
ROOT=$ROLLBACK_TEST_ROOT
CURRENT='aaaa'
TARGET='bbbb'
SHA='bbbb'
record_rollback_evidence
echo "rolled back from $CURRENT to $TARGET"
`;
  const result = spawnSync(bash, ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...gitBashEnv(), ROLLBACK_TEST_ROOT: rootBash }
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe('rollback evidence (PR #69)', () => {
  it('writes durable evidence to a root-only evidence directory', () => {
    const rootDir = makeRoot();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rolled back from aaaa to bbbb');

    const logPath = join(rootDir, 'evidence', 'rollback.log');
    expect(existsSync(logPath)).toBe(true);
    const body = readFileSync(logPath, 'utf8');
    // GNU `date -u -Is` prints +00:00 on Git Bash and Z on some platforms;
    // both are the same UTC instant.
    expect(body).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|\+00:00) rolled back from aaaa to bbbb\n---\n$/
    );
  });

  it('refuses to follow a symlink planted at the log path', () => {
    const rootDir = makeRoot();
    mkdirSync(join(rootDir, 'evidence'), { recursive: true });
    const victim = join(rootDir, 'victim');
    writeFileSync(victim, 'pristine\n');
    try {
      // An attacker who somehow gained write access pre-creates rollback.log
      // as a symlink out of the evidence directory.
      symlinkSync(victim, join(rootDir, 'evidence', 'rollback.log'));
    } catch {
      // Windows without symlink privilege: the refusal path is still reachable
      // by making rollback.log a directory (non-regular target).
      mkdirSync(join(rootDir, 'evidence', 'rollback.log'), { recursive: true });
    }

    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('refusing');
    expect(readFileSync(victim, 'utf8')).toBe('pristine\n');
  });

  it('is non-fatal when evidence cannot be written', () => {
    const rootDir = makeRoot();
    // Make $ROOT itself a regular file so mkdir -p "$ROOT/evidence" fails.
    writeFileSync(join(rootDir, 'blocker'), 'x\n');
    root = join(rootDir, 'blocker');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rolled back from aaaa to bbbb');
    expect(result.stderr).toContain('warning');
  });

  it('refuses to use an evidence directory that is a symlink', () => {
    const rootDir = makeRoot();
    const realDir = join(rootDir, 'real');
    mkdirSync(realDir, { recursive: true });
    try {
      symlinkSync(realDir, join(rootDir, 'evidence'));
    } catch {
      // Windows without symlink privilege: fall back to a regular file so the
      // not-a-directory guard trips instead.
      writeFileSync(join(rootDir, 'evidence'), 'x\n');
    }

    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/refusing to use symlink evidence directory|not a directory/);
    expect(result.stdout).toContain('rolled back from aaaa to bbbb');
    expect(existsSync(join(realDir, 'rollback.log'))).toBe(false);
  });

  it('keeps the service logs directory out of the evidence path', () => {
    const rootDir = makeRoot();
    mkdirSync(join(rootDir, 'logs'), { recursive: true });
    writeFileSync(join(rootDir, 'logs', 'rollback.log'), 'stale\n');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(rootDir, 'evidence', 'rollback.log'))).toBe(true);
    expect(readFileSync(join(rootDir, 'logs', 'rollback.log'), 'utf8')).toBe('stale\n');
  });
});
