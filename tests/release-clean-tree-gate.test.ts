import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The release gate is named `clean`, and the finding was that it did not mean
 * it in the same way everywhere: `scripts/build-release.sh` checked only before
 * `npm run build:all` while `.github/workflows/quality.yml` checked only after
 * packaging, so `npm run ci:local` never proved that building and packaging left
 * the tree alone. Both now call one canonical implementation,
 * `scripts/assert-clean-tree.sh`, before the build and again after packaging.
 *
 * This file exercises that implementation for real inside a throwaway git
 * repository instead of asserting on source text, so a future edit that keeps
 * the wording but breaks the behaviour fails here.
 */
const build = readFileSync('scripts/build-release.sh', 'utf8');
const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
const template = readFileSync('.github/pull_request_template.md', 'utf8');

const CANONICAL_DOCS = [
  'docs/decisions/ADR-003-quality-gates.md',
  'docs/adr/ADR-012-local-release-authority.md',
  'docs/runbooks/operator-release-authority.md',
  'README.md'
] as const;

/** Convert a native path into the form understood by Git Bash and POSIX Bash. */
function bashPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return drive ? `/${drive[1]?.toLowerCase()}/${drive[2]}` : normalized;
}

/**
 * Windows may expose the WSL launcher as `bash` before Git Bash. Resolve the
 * Bash shipped with the same Git installation the checkout already depends on,
 * matching scripts/ci-shell-gates.mjs and tests/snapshot-healthcheck.test.ts.
 */
function resolveBashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const candidate = path.resolve(gitExecPath, '..', '..', '..', 'bin', 'bash.exe');
  if (!existsSync(candidate)) {
    throw new Error(`Git Bash executable not found beside git exec path: ${candidate}`);
  }
  return candidate;
}

const bash = resolveBashExecutable();
const assertion = path.resolve('scripts/assert-clean-tree.sh');

describe('canonical clean-tree assertion behaviour', () => {
  let repository: string;

  function git(...arguments_: string[]) {
    const result = spawnSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr}`);
    }
    return result;
  }

  /** Run the assertion with the throwaway repository as its working directory. */
  function assertClean(stage = 'preflight') {
    return spawnSync(bash, [bashPath(assertion), stage], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined }
    });
  }

  beforeAll(async () => {
    repository = await mkdtemp(path.join(tmpdir(), 'clean-tree-'));
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'gate@example.invalid');
    git('config', 'user.name', 'Clean Tree Gate');
    git('config', 'commit.gpgsign', 'false');
    // The canonical ignores the real repository relies on. dist/ and .release/
    // are generated output; the assertion must tolerate them and nothing else.
    await writeFile(path.join(repository, '.gitignore'), 'dist/\n.release/\n');
    await mkdir(path.join(repository, 'src'), { recursive: true });
    await writeFile(path.join(repository, 'src', 'main.ts'), 'export const value = 1;\n');
    // The assertion under test is the repository's own file, copied in so the
    // throwaway tree can commit it and remain clean while running it.
    await mkdir(path.join(repository, 'scripts'), { recursive: true });
    await copyFile(assertion, path.join(repository, 'scripts', 'assert-clean-tree.sh'));
    git('add', '-A');
    git('commit', '-m', 'baseline');
  });

  afterAll(async () => {
    await rm(repository, { recursive: true, force: true });
  });

  it('exits 0 on a committed baseline', () => {
    const result = assertClean();
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('fails on an untracked non-ignored file and names the path', async () => {
    const offending = 'src/leftover.ts';
    await writeFile(path.join(repository, offending), 'export const leftover = 1;\n');
    try {
      const result = assertClean('after packaging');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(offending);
      expect(result.stderr).toContain('after packaging');
      expect(result.stderr).toContain('including untracked files');
    } finally {
      await rm(path.join(repository, offending), { force: true });
    }
    expect(assertClean().status).toBe(0);
  });

  it('fails on a modified tracked file and names the path', async () => {
    const tracked = path.join(repository, 'src', 'main.ts');
    const original = readFileSync(tracked, 'utf8');
    await writeFile(tracked, 'export const value = 2;\n');
    try {
      const result = assertClean();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('src/main.ts');
    } finally {
      await writeFile(tracked, original);
    }
    expect(assertClean().status).toBe(0);
  });

  it('tolerates generated output covered by the canonical ignores', async () => {
    await mkdir(path.join(repository, 'dist', 'public'), { recursive: true });
    await writeFile(path.join(repository, 'dist', 'public', 'admin.html'), '<!doctype html>\n');
    await mkdir(path.join(repository, '.release'), { recursive: true });
    await writeFile(path.join(repository, '.release', 'artifact.tar.gz'), 'not-a-real-artifact');

    const result = assertClean('after packaging');
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });
});

describe('release clean-tree gate wiring', () => {
  it('never suppresses untracked files anywhere in the gate', () => {
    for (const [name, source] of [
      ['scripts/assert-clean-tree.sh', readFileSync('scripts/assert-clean-tree.sh', 'utf8')],
      ['scripts/build-release.sh', build],
      ['.github/workflows/quality.yml', workflow],
      ['.github/pull_request_template.md', template]
    ] as const) {
      expect({ name, suppressed: source.includes('--untracked-files=no') }).toEqual({
        name,
        suppressed: false
      });
      expect({ name, suppressed: source.includes('-uno') }).toEqual({ name, suppressed: false });
    }
  });

  it('keeps exactly one implementation of the assertion', () => {
    // A second inline `git status --porcelain` block is how the workstation and
    // CI semantics drifted apart in the first place.
    for (const [name, source] of [
      ['scripts/build-release.sh', build],
      ['.github/workflows/quality.yml', workflow]
    ] as const) {
      expect({ name, inline: source.includes('git status --porcelain') }).toEqual({
        name,
        inline: false
      });
      expect(source).toContain('assert-clean-tree.sh');
    }
  });

  it('checks the tree before spending a build on it and again after packaging', () => {
    expect(build).toContain('CLEAN_TREE="$SCRIPT_DIR/assert-clean-tree.sh"');
    const preflight = build.indexOf('bash "$CLEAN_TREE" preflight');
    const compile = build.indexOf('npm run build:all');
    const tarball = build.indexOf('tar -C "$STAGE"');
    const checksum = build.indexOf('sha256sum "$SHA.tar.gz"');
    const post = build.indexOf(`bash "$CLEAN_TREE" 'after packaging'`);
    expect(preflight).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(preflight);
    expect(tarball).toBeGreaterThan(compile);
    expect(checksum).toBeGreaterThan(tarball);
    expect(post).toBeGreaterThan(checksum);
  });

  it('makes the CI gate invoke the same canonical implementation', () => {
    const clean = workflow.slice(workflow.indexOf('id: clean'));
    expect(clean).toContain(`bash scripts/assert-clean-tree.sh 'after packaging'`);
  });

  it('describes preflight and post-package verification in the template and docs', () => {
    expect(template).toContain('untracked files included');
    expect(template).toContain('scripts/assert-clean-tree.sh');
    for (const path of CANONICAL_DOCS) {
      const source = readFileSync(path, 'utf8');
      expect({ path, documented: /untracked/i.test(source) }).toEqual({ path, documented: true });
      expect({ path, canonical: source.includes('assert-clean-tree.sh') }).toEqual({
        path,
        canonical: true
      });
    }
  });

  it('does not hide files to satisfy the gate', () => {
    // The fix must not be a wider .gitignore. Everything ignored is generated
    // output or local state; no source directory may appear.
    const ignored = readFileSync('.gitignore', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    for (const pattern of ignored) {
      expect({
        pattern,
        hidesSource: /^(src|tests|scripts|web|infra|docs|\.github)\b/.test(pattern)
      }).toEqual({ pattern, hidesSource: false });
    }
  });
});
