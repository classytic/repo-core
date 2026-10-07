import { createMemoryCommandStreamStore } from '../../../src/sync/index.js';
import { runCommandStreamStoreConformance } from '../../../src/testing/command-stream-conformance.js';

runCommandStreamStoreConformance({ createStore: () => createMemoryCommandStreamStore() });
