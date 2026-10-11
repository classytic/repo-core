/**
 * `@classytic/repo-core/errors` is imported by browser bundles (SDK cursor recogniser, pos-ui):
 * no module reachable from its entry may import a `node:` builtin. Also pins the cursor codes there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURSOR_ERROR_CODES } from '../../../src/errors/index.js';

function reachable(entry: string): { files: string[]; nodeImports: string[] } {
  const seen = new Set<string>();
  const nodeImports: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1] as string;
      if (spec.startsWith('node:')) nodeImports.push(`${path.basename(file)} -> ${spec}`);
      else if (spec.startsWith('.'))
        walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  };
  walk(entry);
  return { files: [...seen], nodeImports };
}

describe('repo-core/errors is browser-safe', () => {
  it('reaches no node: builtin', () => {
    const { files, nodeImports } = reachable(path.resolve('src/errors/index.ts'));
    expect(files.length).toBeGreaterThan(3);
    expect(nodeImports).toEqual([]);
  });

  it('owns the one cursor-refusal vocabulary', () => {
    expect(CURSOR_ERROR_CODES).toEqual({
      INVALID: 'repo.cursor.invalid',
      SCOPE_MISMATCH: 'repo.cursor.scope_mismatch',
    });
  });
});
