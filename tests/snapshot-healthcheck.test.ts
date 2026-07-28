import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/ping-snapshot-healthcheck.sh');

function withoutHealthcheckUrl(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.SNAPSHOT_HEALTHCHECK_URL;
  return environment;
}

describe('snapshot dead-man notification', () => {
  it('does nothing safely when monitoring is not configured', () => {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: withoutHealthcheckUrl()
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('snapshot monitoring disabled');
  });

  it('rejects a non-HTTPS endpoint before invoking curl', () => {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SNAPSHOT_HEALTHCHECK_URL: 'http://monitor.example.invalid/ping-id'
      }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must use https');
  });

  it('pings an HTTPS endpoint without printing the bearer URL', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'snapshot-healthcheck-'));
    const bin = path.join(directory, 'bin');
    const curl = path.join(bin, 'curl');
    const capture = path.join(directory, 'curl-arguments');
    const url = 'https://monitor.example.invalid/ping-id';

    try {
      await mkdir(bin);
      await writeFile(
        curl,
        '#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf "%s\\n" "$@" > "$CAPTURE_FILE"\n'
      );
      await chmod(curl, 0o755);

      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CAPTURE_FILE: capture,
          SNAPSHOT_HEALTHCHECK_URL: url
        }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('snapshot healthcheck notified');
      expect(`${result.stdout}${result.stderr}`).not.toContain(url);

      const argumentsPassed = (await readFile(capture, 'utf8')).split('\n');
      expect(argumentsPassed).toContain('=https');
      expect(argumentsPassed).toContain('--max-redirs');
      expect(argumentsPassed).toContain('0');
      expect(argumentsPassed).toContain(url);
      expect(argumentsPassed).not.toContain('--retry-all-errors');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries portably and succeeds on the third attempt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'snapshot-healthcheck-retry-'));
    const bin = path.join(directory, 'bin');
    const curl = path.join(bin, 'curl');
    const sleep = path.join(bin, 'sleep');
    const counter = path.join(directory, 'attempts');

    try {
      await mkdir(bin);
      await writeFile(
        curl,
        '#!/usr/bin/env bash\nset -Eeuo pipefail\ncount=0\n[[ ! -f $COUNTER_FILE ]] || count=$(cat "$COUNTER_FILE")\ncount=$((count + 1))\nprintf "%s" "$count" > "$COUNTER_FILE"\n(( count >= 3 ))\n'
      );
      await writeFile(sleep, '#!/usr/bin/env bash\nexit 0\n');
      await chmod(curl, 0o755);
      await chmod(sleep, 0o755);

      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          COUNTER_FILE: counter,
          SNAPSHOT_HEALTHCHECK_URL: 'https://monitor.example.invalid/ping-id'
        }
      });

      expect(result.status).toBe(0);
      expect(await readFile(counter, 'utf8')).toBe('3');
      expect(result.stdout).toContain('snapshot healthcheck notified');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
