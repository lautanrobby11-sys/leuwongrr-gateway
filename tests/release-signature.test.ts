import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A16: release artifacts are signed with the operator's Ed25519 key
 * (ssh-keygen -Y sign, namespace "file"); deploy.sh verifies against the host
 * trust anchor and fails closed without a valid signature. CI never signs (it
 * has no private key), so these tests exercise the real script and the real
 * ssh-keygen with disposable keys, the same pattern as
 * tests/release-reproducible-artifact.test.ts and
 * tests/rollback-manifest-verification.test.ts.
 *
 * Paths: Node writes via native paths; every shell command runs through the
 * resolved bash with POSIX paths, mirroring how the operator's Git Bash runs
 * the release scripts.
 */

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Git Bash on Windows (WSL launcher is useless), system bash elsewhere. */
function resolveBash(): string {
  if (process.platform === 'darwin') return '/bin/bash';
  if (process.platform !== 'win32') return '/usr/bin/bash';
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  return join(gitExecPath, '..', '..', '..', 'usr', 'bin', 'bash.exe');
}

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Convert a Windows path to the POSIX form Git Bash passes to native tools. */
function toPosix(path: string): string {
  if (process.platform !== 'win32') return path;
  const r = spawnSync(resolveBash(), ['-c', 'cygpath -u "$1"', '_', path], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

function hasSshKeygen(): boolean {
  const r = spawnSync(resolveBash(), ['-c', 'command -v ssh-keygen >/dev/null 2>&1'], { encoding: 'utf8' });
  return r.status === 0;
}

function runBash(command: string, env: Record<string, string> = {}) {
  return spawnSync(resolveBash(), ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const SHA = 'd9b199ae04539e58bf2eb24468c5656cc96c1b88';

/** Throwaway Ed25519 keypair; returns POSIX paths for shell use. */
function makeSigner(dir: string): { key: string; signers: string } {
  const key = toPosix(join(dir, 'signer'));
  const gen = runBash('ssh-keygen -t ed25519 -N "" -C test-signer -f "$KEY"', { KEY: key });
  expect(gen.status, gen.stderr).toBe(0);
  const base64 = readFileSync(join(dir, 'signer.pub'), 'utf8').trim().split(/\s+/)[1];
  const signers = join(dir, 'allowed_signers');
  writeFileSync(signers, `release-signer ssh-ed25519 ${base64} test-signer\n`);
  return { key, signers: toPosix(signers) };
}

/**
 * A repo-shaped fixture: scripts/sign-release.sh plus (optionally) the
 * .release/<sha>.tar.gz[.sha256] pair the script signs.
 */
function makeReleaseFixture(withArtifact = true): {
  root: string;
  tar: string;
  checksum: string;
  checksumNative: string;
  sig: string;
} {
  const root = newDir('lwrr-sign-');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, '.release'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'sign-release.sh'),
    readFileSync(join(process.cwd(), 'scripts', 'sign-release.sh'), 'utf8'),
  );
  const tarNative = join(root, '.release', `${SHA}.tar.gz`);
  const checksumNative = join(root, '.release', `${SHA}.tar.gz.sha256`);
  if (withArtifact) {
    writeFileSync(tarNative, 'fake tarball bytes\n');
    writeFileSync(
      checksumNative,
      `aa64700b323c8e4537a39eb3472dafb233e9a1e1048d60c67bec64777c4e4988  ${SHA}.tar.gz\n`,
    );
  }
  return {
    root: toPosix(root),
    tar: toPosix(tarNative),
    checksum: toPosix(checksumNative),
    checksumNative,
    sig: toPosix(`${checksumNative}.sig`),
  };
}

function sign(repoRoot: string, signKey: string): ReturnType<typeof runBash> {
  return runBash('cd "$ROOT" && bash scripts/sign-release.sh "$SHA"', {
    ROOT: repoRoot,
    SHA,
    SIGN_KEY: signKey,
  });
}

function verify(signers: string, sig: string, checksum: string): ReturnType<typeof runBash> {
  return runBash('ssh-keygen -Y verify -f "$SIGNERS" -I release-signer -n file -s "$SIG" < "$CHECK"', {
    SIGNERS: signers,
    SIG: sig,
    CHECK: checksum,
  });
}

function gate(tar: string, signers: string, env: Record<string, string> = {}) {
  return runBash('source scripts/deploy.sh; verify_artifact_signature "$ART" "$SIGNERS"', {
    ART: tar,
    SIGNERS: signers,
    ...env,
  });
}

describe('release artifact signature (A16)', () => {
  it.skipIf(!hasSshKeygen())('sign-release.sh signs the checksum and verify accepts it', () => {
    const { key, signers } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();

    const signed = sign(fixture.root, key);
    expect(signed.status, signed.stderr).toBe(0);
    expect(signed.stdout).toContain('signed:');
    expect(existsSync(fixture.checksumNative + '.sig')).toBe(true);

    const ok = verify(signers, fixture.sig, fixture.checksum);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Good');
  });

  it.skipIf(!hasSshKeygen())('rejects a checksum tampered after signing', () => {
    const { key, signers } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();
    expect(sign(fixture.root, key).status).toBe(0);

    writeFileSync(fixture.checksumNative, 'tampered\n');
    const bad = verify(signers, fixture.sig, fixture.checksum);
    expect(bad.status).not.toBe(0);
  });

  it.skipIf(!hasSshKeygen())('rejects a signature made by an unauthorized principal', () => {
    const dir = newDir('lwrr-sign-key-');
    const { key } = makeSigner(dir);
    const fixture = makeReleaseFixture();
    expect(sign(fixture.root, key).status).toBe(0);

    const otherSigners = join(dir, 'other_signers');
    const base64 = readFileSync(join(dir, 'signer.pub'), 'utf8').trim().split(/\s+/)[1];
    writeFileSync(otherSigners, `someone-else ssh-ed25519 ${base64}\n`);
    const bad = verify(toPosix(otherSigners), fixture.sig, fixture.checksum);
    expect(bad.status).not.toBe(0);
  });

  it.skipIf(!hasSshKeygen())('signing is deterministic: two runs produce byte-identical signatures', () => {
    const { key } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();
    expect(sign(fixture.root, key).status).toBe(0);
    const first = readFileSync(fixture.checksumNative + '.sig');
    expect(sign(fixture.root, key).status).toBe(0);
    expect(readFileSync(fixture.checksumNative + '.sig')).toEqual(first);
  });

  it('fails fast when the artifact or the signing key is missing', () => {
    const { key } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();
    const emptyFixture = makeReleaseFixture(false);

    const noArtifact = runBash('cd "$ROOT" && bash scripts/sign-release.sh "$SHA"', {
      ROOT: emptyFixture.root,
      SHA,
      SIGN_KEY: key,
    });
    expect(noArtifact.status).not.toBe(0);
    expect(noArtifact.stderr).toContain('artifact missing');

    const noKey = sign(fixture.root, toPosix(join(newDir('lwrr-sign-nokey-'), 'nope')));
    expect(noKey.status).not.toBe(0);
    expect(noKey.stderr).toContain('signing key missing');
  });

  it('deploy.sh fails closed without a signature', () => {
    const { signers } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();
    const result = gate(fixture.tar, signers);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.sha256.sig');
  });

  it('deploy.sh fails when the host signers file is absent', () => {
    const { key } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();
    expect(sign(fixture.root, key).status).toBe(0);

    const result = gate(fixture.tar, toPosix(join(newDir('lwrr-sign-nosig-'), 'absent_signers')));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release signers file missing');
  });

  it.skipIf(!hasSshKeygen())('deploy.sh accepts a valid signature and rejects a tampered one', () => {
    const { key, signers } = makeSigner(newDir('lwrr-sign-key-'));
    const fixture = makeReleaseFixture();
    expect(sign(fixture.root, key).status).toBe(0);

    expect(gate(fixture.tar, signers).status).toBe(0);

    writeFileSync(fixture.checksumNative, 'tampered\n');
    const bad = gate(fixture.tar, signers);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('artifact signature verification failed');
  });

  it('build-release.sh stages keys/release-signers into the artifact', () => {
    const build = readFileSync(join(process.cwd(), 'scripts', 'build-release.sh'), 'utf8');
    expect(build).toContain('keys/release-signers');
    expect(build).toContain('mkdir -p "$STAGE/keys"');
    expect(build).toContain('cp keys/release-signers "$STAGE/keys/"');
  });

  it('vps-bootstrap.sh seeds the trust anchor without overwriting a rotated key', () => {
    const bootstrap = readFileSync(join(process.cwd(), 'scripts', 'vps-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain('config/release-signers');
    expect(bootstrap).toContain('already present; not overwriting');
    // The bare-host runbook extracts only the script into /tmp, so the signers
    // source must be an explicit argument, not a relative lookup from the
    // staged copy (CodeRabbit on PR #70).
    expect(bootstrap).toContain('SIGNERS_SRC=${2:-$SCRIPT_DIR/../keys/release-signers}');
    expect(bootstrap).toContain('install -o root -g root -m 0644 "$SIGNERS_SRC"');
  });

  it('keys/release-signers holds only a public key and no private key block', () => {
    const signers = readFileSync(join(process.cwd(), 'keys', 'release-signers'), 'utf8');
    expect(signers).toMatch(/^release-signer ssh-ed25519 [A-Za-z0-9+/]+={0,2} /m);
    expect(signers).not.toMatch(/PRIVATE KEY/);
  });

  it('the release runbook documents signature in gate, transfer, and evidence', () => {
    const runbook = readFileSync(
      join(process.cwd(), 'docs', 'runbooks', 'operator-release-authority.md'),
      'utf8',
    );
    expect(runbook).toContain('sign-release.sh');
    expect(runbook).toContain('.sha256.sig');
    expect(runbook).toContain('signature verification result and signer fingerprint');
  });
});
