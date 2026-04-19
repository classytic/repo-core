/**
 * Public entry for the `operations` subpath.
 *
 * Consumers import from `@classytic/repo-core/operations` — never from
 * a deeper path. Siblings of this file (`types.ts`, `registry.ts`) are
 * implementation details and may be restructured between minor versions.
 */

export {
  CORE_OP_REGISTRY,
  describe,
  extendRegistry,
  listOperations,
  mutatingOperations,
  operationsByPolicyKey,
  readOperations,
} from './registry.js';
export type {
  CoreRepositoryOperation,
  OperationDescriptor,
  OperationRegistry,
  PolicyKey,
  RepositoryOperation,
} from './types.js';
