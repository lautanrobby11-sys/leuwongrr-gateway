import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
