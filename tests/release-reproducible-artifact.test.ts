import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A14: two builds of one commit produced two different tarball checksums, so the
 * `.sha256` beside an artifact bound it to the run that happened to produce it
 * rather than to the commit its filename names. That defeats the point of the
 * checksum in the release evidence: an operator could not tell a rebuild of the
 * right commit apart from a build of something else.
 *
 * Three inputs were drifting, and all three are asserted here rather than read
 * out of the source text, because a comment claiming determinism is exactly what
 * the audit found already present and untrue:
 *   1. `RELEASE` carried `built_at=$(date -u ...)`, which changed the RELEASE
 *      bytes, hence its line in `manifest.sha256`, hence the archive.
 *   2. `tar` recorded live mtimes and the building account's uid/gid.
 *   3. `gzip` stamped its own name/timestamp header.
 *
 * The packaging half of scripts/build-release.sh is re-executed here against a
 * fixture tree instead of invoking the real script: the real script runs
 * `npm run build:all` twice, which would put a multi-minute compile inside a unit
 * test, and the compiler output is not what is under test. The packaging block is
 * extracted from the real file so an edit there is picked up rather than mirrored.
 */

function bashPath(value: string): string {
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
const buildSource = readFileSync('scripts/build-release.sh', 'utf8');

/**
 * The packaging block: from the RELEASE record through the checksum. Slicing the
 * real script keeps this test honest about what ships; hard-coding a copy of the
 * tar flags would pass even if scripts/build-release.sh lost them.
 */
function extractPackagingBlock(): string {
  const start = buildSource.indexOf('SOURCE_DATE_EPOCH=$(git log -1');
  // Ends at the closing paren of the checksum subshell, not at the sha256sum line
  // itself: stopping mid-subshell leaves an unbalanced `(` and the harness dies
  // with a syntax error instead of exercising the packaging it was given.
  const endMarker = 'sha256sum "$SHA.tar.gz" > "$SHA.tar.gz.sha256"\n)';
  const end = buildSource.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error('packaging block not found in scripts/build-release.sh');
  }
  return buildSource.slice(start, end + endMarker.length);
}

const FIXED_EPOCH = 1_700_000_000;

describe('release artifact reproducibility (A14)', () => {
  let workspace: string;
  let harness: string;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'a14-'));

    // A fixture that exercises each normalization: a nested directory, a file
    // whose mode differs from the rest, and a shell script that must end at 0755.
    const stage = path.join(workspace, 'stage');
    await mkdir(path.join(stage, 'dist', 'cli'), { recursive: true });
    await mkdir(path.join(stage, 'scripts'), { recursive: true });
    await writeFile(path.join(stage, 'dist', 'cli', 'keys.js'), 'export const keys = 1;\n');
    await writeFile(path.join(stage, 'dist', 'entry.js'), 'export const entry = 2;\n');
    await writeFile(path.join(stage, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(path.join(stage, 'scripts', 'deploy.sh'), '#!/usr/bin/env bash\ntrue\n');
    // Deliberately wrong modes so the normalization has something to correct.
    await chmod(path.join(stage, 'dist', 'entry.js'), 0o600);
    await chmod(path.join(stage, 'scripts', 'deploy.sh'), 0o644);

    // A stub `git log -1 --format=%ct` so the block resolves a committer date
    // without needing a real repository, and so the epoch under test is fixed.
    const stubs = path.join(workspace, 'stubs');
    await mkdir(stubs, { recursive: true });
    const gitStub = path.join(stubs, 'git');
    await writeFile(gitStub, `#!/usr/bin/env bash\nprintf '%s\\n' ${FIXED_EPOCH}\n`);
    await chmod(gitStub, 0o755);

    harness = path.join(workspace, 'package.sh');
    await writeFile(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -Eeuo pipefail',
        'PATH="$STUBS:$PATH"',
        'SHA=$1',
        'STAGE=$2',
        'cd "$WORKDIR"',
        'mkdir -p .release',
        extractPackagingBlock(),
        ''
      ].join('\n')
    );
    await chmod(harness, 0o755);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** Package the fixture into `.release/<sha>.tar.gz` under its own output dir. */
  async function pack(run: string): Promise<{ archive: Buffer; checksum: string }> {
    const workdir = path.join(workspace, run);
    await mkdir(workdir, { recursive: true });
    const sha = 'a'.repeat(40);
    const result = spawnSync(bash, [bashPath(harness), sha, bashPath(path.join(workspace, 'stage'))], {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        ...process.env,
        STUBS: bashPath(path.join(workspace, 'stubs')),
        WORKDIR: bashPath(workdir)
      }
    });
    if (result.status !== 0) {
      throw new Error(`packaging failed (${result.status}): ${result.stderr}`);
    }
    const archive = await readFile(path.join(workdir, '.release', `${sha}.tar.gz`));
    const checksum = await readFile(path.join(workdir, '.release', `${sha}.tar.gz.sha256`), 'utf8');
    return { archive, checksum };
  }

  function digest(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  it('produces a byte-identical archive from two runs a second apart', async () => {
    const first = await pack('run-1');
    // A whole second of wall clock: the defect was a timestamp read at package
    // time, so two runs inside the same second could have hidden it.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await pack('run-2');

    expect(digest(second.archive)).toBe(digest(first.archive));
    expect(second.checksum).toBe(first.checksum);
  });

  it('records the committer date, not the packaging moment, in RELEASE', async () => {
    const { archive } = await pack('run-release');
    const extracted = path.join(workspace, 'extract-release');
    await mkdir(extracted, { recursive: true });
    await writeFile(path.join(workspace, 'release.tar.gz'), archive);
    const untar = spawnSync(
      'tar',
      ['-C', bashPath(extracted), '-xzf', bashPath(path.join(workspace, 'release.tar.gz'))],
      { encoding: 'utf8' }
    );
    expect(untar.status).toBe(0);

    const record = await readFile(path.join(extracted, 'RELEASE'), 'utf8');
    const expected = new Date(FIXED_EPOCH * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(record).toContain(`committed_at=${expected}`);
    // The drifting field must be gone, not merely accompanied.
    expect(record).not.toContain('built_at=');
  });

  it('strips the building account and pins mtimes to the commit', async () => {
    const { archive } = await pack('run-metadata');
    await writeFile(path.join(workspace, 'metadata.tar.gz'), archive);
    const listing = spawnSync(
      'tar',
      ['-tvf', bashPath(path.join(workspace, 'metadata.tar.gz')), '--numeric-owner'],
      { encoding: 'utf8' }
    );
    expect(listing.status).toBe(0);

    const rows = listing.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(rows.length).toBeGreaterThan(0);
    // `tar -tv` renders mtimes in the local zone, so the expected stamp is built
    // from the same local fields rather than from toISOString(): comparing a UTC
    // string here made the assertion fail on a UTC+7 workstation for a correctly
    // pinned archive, which would have been a false alarm about A14.
    const pinned = new Date(FIXED_EPOCH * 1000);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const stamp =
      `${pinned.getFullYear()}-${pad(pinned.getMonth() + 1)}-${pad(pinned.getDate())} ` +
      `${pad(pinned.getHours())}:${pad(pinned.getMinutes())}`;
    for (const row of rows) {
      expect({ row, owner: row.includes('0/0') }).toEqual({ row, owner: true });
      expect({ row, dated: row.includes(stamp) }).toEqual({ row, dated: true });
    }
  });

  it('omits the gzip name and timestamp header', async () => {
    const { archive } = await pack('run-gzip');
    // RFC 1952: byte 3 is FLG, bytes 4-7 are MTIME. `gzip -n` clears FNAME (0x08)
    // and writes a zero MTIME, which is what makes the container itself stable.
    expect(archive[0]).toBe(0x1f);
    expect(archive[1]).toBe(0x8b);
    expect(archive[3]! & 0x08).toBe(0);
    expect(archive.readUInt32LE(4)).toBe(0);
  });

  it('normalizes staged modes so a different umask cannot change the archive', async () => {
    const { archive } = await pack('run-modes');
    await writeFile(path.join(workspace, 'modes.tar.gz'), archive);
    const listing = spawnSync('tar', ['-tvf', bashPath(path.join(workspace, 'modes.tar.gz'))], {
      encoding: 'utf8'
    });
    expect(listing.status).toBe(0);

    const modeOf = (suffix: string): string | undefined =>
      listing.stdout
        .split('\n')
        .find((line) => line.trimEnd().endsWith(suffix))
        ?.slice(0, 10);

    // entry.js was staged 0600 and deploy.sh 0644; both must be corrected.
    expect(modeOf('./dist/entry.js')).toBe('-rw-r--r--');
    expect(modeOf('./scripts/deploy.sh')).toBe('-rwxr-xr-x');
    expect(modeOf('./dist/')).toBe('drwxr-xr-x');
  });

  it('sorts manifest entries under a fixed collation', () => {
    // A locale-dependent sort reorders manifest.sha256 without any file changing,
    // which changes its checksum and therefore the archive.
    const block = extractPackagingBlock();
    expect(block).toContain('LC_ALL=C sort -z');
  });
});
