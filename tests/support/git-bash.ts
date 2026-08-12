import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveGitBash(): string {
  if (process.platform !== 'win32') return '/usr/bin/bash';
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const gitRoot = join(gitExecPath, '..', '..', '..');
  const bash = join(gitRoot, 'usr', 'bin', 'bash.exe');
  if (!existsSync(bash)) throw new Error(`Git Bash executable not found: ${bash}`);
  return bash;
}

export function toGitBashPath(value: string): string {
  if (process.platform !== 'win32') return value;
  const normalized = value.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]}` : normalized;
}

export function toGitBashPathList(value: string): string {
  return value
    .split(/[;:]/)
    .map((entry) => toGitBashPath(entry))
    .join(':');
}

export function gitBashEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = { ...process.env, ...overrides };
  if (process.platform !== 'win32') return base;
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const gitBin = toGitBashPath(join(gitExecPath, '..', '..', '..', 'usr', 'bin'));
  const separator = ':';
  const overridePath = overrides.PATH ? toGitBashPathList(overrides.PATH) : undefined;
  const path = overridePath
    ? `${overridePath}${separator}${gitBin}`
    : base.PATH
      ? `${gitBin}${separator}${base.PATH}`
      : gitBin;
  return { ...base, PATH: path };
}
