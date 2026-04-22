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
    'update/index': 'src/update/index.ts',
    'query-parser/index': 'src/query-parser/index.ts',
    'context/index': 'src/context/index.ts',
    'cache/index': 'src/cache/index.ts',
    'schema/index': 'src/schema/index.ts',
    'testing/index': 'src/testing/index.ts',
    'lookup/index': 'src/lookup/index.ts',
  },
  outputOptions: {
    preserveModules: true,
    preserveModulesRoot: 'src',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'node22',
  fixedExtension: true, // emit `.mjs` / `.d.mts` — matches mongokit / Classytic house style
  // Types only — no declaration maps (no `.d.mts.map` files in the
  // published tarball). Declaration maps only help IDE "go-to-source"
  // during local development of this package; shipped consumers don't
  // need them and they double dist size.
  dts: { sourcemap: false },
  clean: true,
  unbundle: true, // 1:1 src → dist, no shared chunks
  // No source maps either — the runtime code ships as a single compiled
  // artifact per subpath; we have no production debugger that would
  // resolve back to the original `.ts`. Keep the tarball lean.
  sourcemap: false,
  // exports: false — hand-maintain package.json "exports". Auto-generation
  // collapses to a `"."` root entry when there's a single subpath, which
  // violates the no-root-barrel rule. See INFRA.md §4.
  publint: 'ci-only',
  attw: 'ci-only',
});
