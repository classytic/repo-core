import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: ['src/**/index.ts'],
  project: ['src/**/*.ts'],
  // @arethetypeswrong/cli is consumed indirectly via tsdown's `attw: 'ci-only'`
  // option — knip doesn't see the transitive wire-up so the package looks unused.
  ignoreDependencies: ['@arethetypeswrong/cli'],
  // `FilterRaw` is a public type for kit compilers to pattern-match on — no
  // source file inside repo-core imports it, and that's intentional. Exporting
  // it is the contract; suppressing the "unused export" warning here.
  ignoreExportsUsedInFile: { type: true },
  vitest: {
    config: ['vitest.config.ts'],
    entry: ['tests/**/*.test.ts', 'tests/helpers/**/*.ts'],
  },
};

// biome-ignore lint/style/noDefaultExport: knip requires default export
export default config;
