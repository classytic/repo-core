/**
 * Run the cross-kit lock conformance suite against the in-memory
 * reference adapter. Acts as the source-of-truth: if a kit's
 * conformance suite passes against this same scenario set, the kit
 * is provably contract-compatible with the memory reference.
 */

import { describe } from 'vitest';
import { createMemoryLockAdapter } from '../../../src/lock/index.js';
import { runLockAdapterConformance } from '../../../src/testing/index.js';

describe('createMemoryLockAdapter — conformance', () => {
  runLockAdapterConformance({
    // Fresh map per describe so post-steal scenarios don't bleed.
    createAdapter: () => createMemoryLockAdapter(),
  });
});
