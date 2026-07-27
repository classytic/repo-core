/**
 * `definePurgeStep` — the standard way to turn a repository purge into a
 * `CleanupStep`.
 *
 * Nearly every provider step is the same shape: resolve a scope value from the
 * sealed run parameters, refuse if it is missing, count the matching rows for
 * the preview, run a chunked `purgeByField`, then prove the rows are gone.
 * Hand-writing that skeleton per collection produced ~40 lines of identical
 * plumbing each time and, worse, let each copy drift on the parts that must
 * NOT vary — fail-closed scoping, cancellation, and "a delete count is never
 * proof" verification.
 *
 * This builder owns that invariant core so a step becomes a DECLARATION: what
 * to match, which strategy, what is retained. Everything domain-specific stays
 * in the spec — `guard` for domain blockers, `verifyFilter` when absence is
 * proven by a different query than the one that matched.
 *
 * Steps whose work is NOT a `purgeByField` (a kernel's own purge verb, a
 * projection rebuild, an array `$pull`) are deliberately out of scope: forcing
 * them through here would mean lying in one of the three phases.
 */

import type { TenantPurgeOptions, TenantPurgeStrategy } from '../repository/types.js';
import type {
  CleanupStep,
  CleanupStepCheck,
  CleanupStepContext,
  CleanupStepEstimate,
  CleanupStepExecuteContext,
  CleanupStepOutcome,
} from './types.js';

/**
 * The repository surface a purge step needs — a structural subset of
 * `StandardRepo`, so any kit repository satisfies it without an adapter.
 * Both members are optional so an engine that never wired the repository
 * yields a BLOCKER rather than a crash.
 */
export interface PurgeStepRepository {
  purgeByField?(
    field: string,
    value: unknown,
    strategy: TenantPurgeStrategy,
    options?: TenantPurgeOptions,
  ): Promise<{ processed: number; ok: boolean; error?: { message: string } }>;
  countDocuments?(filter: Record<string, unknown>): Promise<number>;
}

export interface PurgeStepSpec {
  /** Stable machine id, unique within a recipe. */
  id: string;
  /** Business record class for the preview (e.g. `'CRM contacts'`). */
  resource: string;
  /**
   * Run-parameter key carrying the scope value (e.g. `'subjectId'`,
   * `'organizationId'`). Read from `ctx.parameters` at plan AND execute time,
   * so a retry replays the value the operator actually confirmed.
   */
  parameter: string;
  /** Document field matched against the parameter's value. */
  field: string;
  /** What to do with matched rows. */
  strategy: TenantPurgeStrategy;
  /** What survives — surfaced in the preview. */
  retained?: string;
  /** Non-blocking operator warnings. */
  warnings?: readonly string[];
  /** Rows per chunk. Kit default when omitted. */
  batchSize?: number;
  /**
   * Domain blockers beyond the built-in scope/availability checks (e.g.
   * `'OPEN_CHECKOUTS:3'`). A non-empty result is a HARD STOP.
   */
  guard?: (scope: string, ctx: CleanupStepContext) => Promise<readonly string[]>;
  /**
   * Filter proving absence, when it differs from the match filter — e.g. an
   * anonymize keyed on `_id` leaves the row in place, so absence must be
   * proven by querying the redacted identifier instead.
   */
  verifyFilter?: (scope: string) => Record<string, unknown>;
  /** Overrides the generated check name. */
  verifyName?: string;
}

/** Prefix for the blocker raised when the run carries no scope value. */
export const SCOPE_REQUIRED = 'CLEANUP_SCOPE_REQUIRED';
/** Prefix for the blocker raised when the repository cannot be reached. */
export const REPOSITORY_UNAVAILABLE = 'CLEANUP_REPOSITORY_UNAVAILABLE';

function scopeOf(ctx: CleanupStepContext, parameter: string): string | undefined {
  const raw = ctx.parameters?.[parameter];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Build a `CleanupStep` from a repository + declaration.
 *
 * Invariants this owns, so no caller can get them wrong:
 *   - **fail-closed scoping** — no scope value, or no repository, is a
 *     BLOCKER, never a silent no-op and never an unscoped purge (which would
 *     hit every tenant);
 *   - **cancellation** — checked before work starts and threaded to the kit so
 *     a cancel lands between committed chunks, never mid-write;
 *   - **honest failure** — a failing purge returns `ok: false` so the composer
 *     stops the recipe (retention §8), and a thrown error is reported, never
 *     swallowed;
 *   - **verification** — absence is re-queried after the run, because a
 *     processed count alone is never proof (§9).
 */
export function definePurgeStep(
  repository: PurgeStepRepository | undefined,
  spec: PurgeStepSpec,
): CleanupStep {
  const destructive = spec.strategy.type !== 'skip';
  const verifyName = spec.verifyName ?? `${spec.id}.verified`;
  const filterFor = (scope: string): Record<string, unknown> =>
    spec.verifyFilter?.(scope) ?? { [spec.field]: scope };

  return {
    id: spec.id,
    resource: spec.resource,
    destructive,

    async estimate(ctx: CleanupStepContext): Promise<CleanupStepEstimate> {
      const scope = scopeOf(ctx, spec.parameter);
      if (!scope) {
        return {
          resource: spec.resource,
          estimated: 0,
          blockers: [`${SCOPE_REQUIRED}:${spec.parameter}`],
        };
      }
      if (!repository?.purgeByField) {
        return {
          resource: spec.resource,
          estimated: 0,
          blockers: [`${REPOSITORY_UNAVAILABLE}:${spec.id}`],
        };
      }

      const estimated = (await repository.countDocuments?.({ [spec.field]: scope })) ?? 0;
      const blockers = (await spec.guard?.(scope, ctx)) ?? [];

      return {
        resource: spec.resource,
        estimated,
        ...(spec.retained === undefined ? {} : { retained: spec.retained }),
        ...(blockers.length > 0 ? { blockers: [...blockers] } : {}),
        ...(spec.warnings === undefined ? {} : { warnings: [...spec.warnings] }),
      };
    },

    async execute(ctx: CleanupStepExecuteContext): Promise<CleanupStepOutcome> {
      await ctx.throwIfCancelled?.();
      const scope = scopeOf(ctx, spec.parameter);
      if (!scope || !repository?.purgeByField) {
        // Defensive: the host refuses to execute a plan carrying blockers, so
        // arriving here means the plan was bypassed — fail loudly.
        return {
          resource: spec.resource,
          processed: 0,
          ok: false,
          error: scope
            ? `repository for '${spec.id}' is unavailable`
            : `missing run parameter '${spec.parameter}'`,
        };
      }
      try {
        const result = await repository.purgeByField(spec.field, scope, spec.strategy, {
          ...(spec.batchSize === undefined ? {} : { batchSize: spec.batchSize }),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: async (event) => {
            await ctx.onProgress?.({ resource: spec.resource, processed: event.processed });
          },
        });
        return {
          resource: spec.resource,
          processed: result.processed,
          ok: result.ok,
          ...(result.ok ? {} : { error: result.error?.message ?? 'purge reported failure' }),
        };
      } catch (error) {
        return {
          resource: spec.resource,
          processed: 0,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async verify(ctx: CleanupStepContext): Promise<readonly CleanupStepCheck[]> {
      const scope = scopeOf(ctx, spec.parameter);
      if (!scope || !repository?.countDocuments) {
        // Unverifiable is a FAILED check, never a silent pass.
        return [
          {
            name: verifyName,
            ok: false,
            detail: 'could not verify — no scope or no count support',
          },
        ];
      }
      const remaining = await repository.countDocuments(filterFor(scope));
      return [
        {
          name: verifyName,
          ok: remaining === 0,
          detail:
            remaining === 0
              ? `no ${spec.resource} still match the scope`
              : `${remaining} row(s) still match — cleanup incomplete`,
        },
      ];
    },
  };
}
