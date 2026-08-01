import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * build-release.sh validated that its SHA argument looked like a full git SHA,
 * but never that it was the SHA actually checked out. A caller could therefore
 * package the current working tree under someone else's commit id, producing an
 * artifact whose RELEASE file and filename both lie about what is inside it.
 *
 * The gate has to fire before the build, not after: a late check would still
 * burn a full `npm run build:all` and could leave a half-written artifact.
 */

function toBashPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]}` : normalized;
}

function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const candidate = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
  if (!existsSync(candidate)) throw new Error(`Git Bash not found at ${candidate}`);
  return candidate;
}

const bash = resolveBash();
const scriptSource = path.resolve('scripts/build-release.sh');
const cleanTreeSource = path.resolve('scripts/assert-clean-tree.sh');

describe('build-release.sh SHA identity gate', () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'sha-guard-'));
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'gate@example.invalid');
    git('config', 'user.name', 'SHA Guard');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, '.gitignore'), 'dist/\n.release/\n');
    await mkdir(path.join(repo, 'scripts'), { recursive: true });
    await copyFile(scriptSource, path.join(repo, 'scripts', 'build-release.sh'));
    await copyFile(cleanTreeSource, path.join(repo, 'scripts', 'assert-clean-tree.sh'));
    git('add', '-A');
    git('commit', '-m', 'baseline');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('rejects a valid SHA that is not the checked-out HEAD before building', () => {
    // A well-formed 40-hex SHA that can never be a real commit, so the only
    // thing under test is the identity check and not the format check.
    const otherSha = '0'.repeat(40);
    const result = spawnSync(
      bash,
      [toBashPath(path.join(repo, 'scripts/build-release.sh')), otherSha],
      { cwd: repo, encoding: 'utf8' }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match checked-out HEAD');

    // Proves the refusal happened before packaging, not after.
    const releaseDir = path.join(repo, '.release');
    const artifacts = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
    expect(artifacts).toEqual([]);
  });
});
