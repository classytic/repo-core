import { MemoryChangeLogStore } from '../../../src/sync/index.js';
import { runChangeLogStoreConformance } from '../../../src/testing/change-log-conformance.js';

// The reference store passes the contract; the transaction cases skip (it has none).
runChangeLogStoreConformance({ createStore: () => new MemoryChangeLogStore() });
