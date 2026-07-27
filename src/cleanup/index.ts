/**
 * `@classytic/repo-core/cleanup` — framework-free cleanup provider step
 * contract. Domain kernels implement `CleanupStep`; a host framework
 * (`@classytic/arc/cleanup`) composes steps into a recipe. See `./types.ts`.
 *
 * `definePurgeStep` is the standard builder for the common case — a chunked
 * repository purge — owning the fail-closed scoping, cancellation and
 * verification invariants every provider step must share.
 */

export type { PurgeStepRepository, PurgeStepSpec } from './define-purge-step.js';
export { definePurgeStep, REPOSITORY_UNAVAILABLE, SCOPE_REQUIRED } from './define-purge-step.js';
export type {
  CleanupStep,
  CleanupStepCheck,
  CleanupStepContext,
  CleanupStepEstimate,
  CleanupStepExecuteContext,
  CleanupStepLogger,
  CleanupStepOutcome,
  CleanupStepProgress,
} from './types.js';
