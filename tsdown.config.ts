import { defineConfig } from 'tsdown';

export default defineConfig({
  // One entry per public subpath. Object form keeps the output key explicit,
  // so `dist/` mirrors the public subpath map regardless of how many entries exist.
  entry: {
    'hooks/index': 'src/hooks/index.ts',
    'operations/index': 'src/operations/index.ts',
    'errors/index': 'src/errors/index.ts',
    'pagination/index': 'src/pagination/index.ts',
    'repository/index': 'src/repository/index.ts',
    'filter/index': 'src/filter/index.ts',
    'query-parser/index': 'src/query-parser/index.ts',
    'context/index': 'src/context/index.ts',
    'cache/index': 'src/cache/index.ts',
  },
  outputOptions: {
    preserveModules: true,
    preserveModulesRoot: 'src',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'node22',
  fixedExtension: true, // emit `.mjs` / `.d.mts` — matches mongokit / Classytic house style
  dts: true,
  clean: true,
  unbundle: true, // 1:1 src → dist, no shared chunks
  sourcemap: true,
  // exports: false — hand-maintain package.json "exports". Auto-generation
  // collapses to a `"."` root entry when there's a single subpath, which
  // violates the no-root-barrel rule. See INFRA.md §4.
  publint: 'ci-only',
  attw: 'ci-only',
});
