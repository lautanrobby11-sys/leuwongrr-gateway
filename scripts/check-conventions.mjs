import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const forbidden = /(?:^|[._-])(new|final2?|fix(?:ed)?|hotfix|patch|override|backup|old|temp)(?:[._-]|$)/i;
const ignored = new Set(['.git', 'node_modules', 'dist', 'data', 'logs', 'runtime']);
const violations = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const rel = relative(process.cwd(), path);
    if (forbidden.test(entry.name) || entry.name === 'docker-compose.override.yml') violations.push(rel);
    if (entry.isDirectory()) await walk(path);
  }
}
await walk(process.cwd());
if (violations.length) {
  console.error(`Forbidden duplicate/suffix paths:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Convention gate passed');
