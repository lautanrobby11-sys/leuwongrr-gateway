import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENTED_OPERATIONS,
  PUBLIC_ALLOWLIST,
  resolveRoute,
  type RouteId
} from '../src/policy/allowlist.js';

const PATH_LINE = /^ {2}(\/\S*):$/;
const METHOD_LINE = /^ {4}(get|post):$/;
const OPENAPI_PATH = join(process.cwd(), 'docs/api/openapi.yaml');

/**
 * A line scanner rather than a YAML parser: the gateway ships no parser
 * dependency and the lockfile is pinned, so the document is authored with a
 * fixed two-space path and four-space method layout that this can read.
 */
function operationsInSource(source: string): Set<string> {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf('paths:');
  if (start === -1) throw new Error('openapi.yaml declares no paths block');
  const found = new Set<string>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    const path = PATH_LINE.exec(line);
    if (path?.[1]) {
      current = path[1];
      continue;
    }
    const method = METHOD_LINE.exec(line);
    if (method?.[1]) {
      if (current === null) throw new Error(`method ${method[1]} appears before any path`);
      found.add(`${method[1].toUpperCase()} ${current}`);
    }
  }
  return found;
}

function operationsInSpec(): Set<string> {
  return operationsInSource(readFileSync(OPENAPI_PATH, 'utf8'));
}

function declared(): Set<string> {
  return new Set(DOCUMENTED_OPERATIONS.map((op) => `${op.method} ${op.path}`));
}

describe('published API contract', () => {
  it('documents every operation the gateway declares, and nothing more', () => {
    const spec = [...operationsInSpec()].sort();
    expect(spec.length).toBeGreaterThan(30);
    expect(spec).toEqual([...declared()].sort());
  });

  it('parses the contract after a Windows CRLF checkout', () => {
    const source = readFileSync(OPENAPI_PATH, 'utf8').replace(/\r?\n/g, '\r\n');
    expect([...operationsInSource(source)].sort()).toEqual([...declared()].sort());
  });

  it('keeps every documented path reachable through the allowlist', () => {
    for (const operation of DOCUMENTED_OPERATIONS) {
      expect({
        operation: `${operation.method} ${operation.sample}`,
        id: resolveRoute(operation.method, operation.sample)
      }).toEqual({ operation: `${operation.method} ${operation.sample}`, id: operation.id });
    }
  });

  it('leaves no allowlisted route undocumented', () => {
    const documented = new Set<RouteId>(DOCUMENTED_OPERATIONS.map((op) => op.id));
    const allowlisted = new Set<RouteId>(PUBLIC_ALLOWLIST.map((route) => route.id));
    expect([...allowlisted].sort()).toEqual([...documented].sort());
  });

  it('never publishes a path that resolves to nothing', () => {
    for (const operation of DOCUMENTED_OPERATIONS) {
      expect(resolveRoute(operation.method, operation.sample)).not.toBeNull();
    }
  });
});
