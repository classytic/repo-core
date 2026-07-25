/**
 * `@classytic/repo-core/cleanup` — framework-free cleanup provider step
 * contract. Domain kernels implement `CleanupStep`; a host framework
 * (`@classytic/arc/cleanup`) composes steps into a recipe. See `./types.ts`.
 */
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
