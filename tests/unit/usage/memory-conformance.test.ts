/**
 * Reference memory store run through the canonical contract suite —
 * the same suite every kit adapter (mongokit/usage, sqlitekit/usage)
 * imports. Memory passing it proves the suite and the reference agree.
 */
import { describe } from 'vitest';
import { runUsageStoreContract } from '../../../src/testing/usage-conformance.js';
import { createMemoryUsageStore } from '../../../src/usage/index.js';

describe('memory usage store conformance', () => {
  runUsageStoreContract({
    createStore: () => createMemoryUsageStore(),
  });
});
