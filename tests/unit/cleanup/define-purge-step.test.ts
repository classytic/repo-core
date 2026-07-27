/**
 * `definePurgeStep` tests.
 *
 * This builder owns the invariants every cleanup provider step must share, so
 * the tests are written against those invariants rather than any one domain:
 *
 *   1. Fail-closed scoping — a missing scope or repository BLOCKS, and never
 *      degrades into an unscoped purge (which would hit every tenant).
 *   2. Cancellation — probed before work starts and threaded to the kit so a
 *      cancel lands between committed chunks.
 *   3. Honest failure — a failing or throwing purge reports `ok: false`
 *      (retention §8: never claim success past a provider failure).
 *   4. Verification — absence is re-queried after the run, because a processed
 *      count alone is never proof (§9), and "cannot verify" FAILS.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  definePurgeStep,
  type PurgeStepRepository,
  REPOSITORY_UNAVAILABLE,
  SCOPE_REQUIRED,
} from '../../../src/cleanup/index.js';

const NOW = new Date('2026-07-27T00:00:00.000Z');
const ctx = (parameters?: Record<string, unknown>) => ({
  now: NOW,
  ...(parameters ? { parameters } : {}),
});
const SCOPED = { subjectId: 'subject-1' };

/** Repository stand-in recording what it was asked to do. */
function repo(
  overrides: Partial<{
    count: number;
    purge: PurgeStepRepository['purgeByField'];
    noPurge: boolean;
    noCount: boolean;
  }> = {},
) {
  const calls = {
    countFilters: [] as Record<string, unknown>[],
    purgeArgs: [] as unknown[][],
  };
  const r: PurgeStepRepository = {
    ...(overrides.noCount
      ? {}
      : {
          countDocuments: async (filter: Record<string, unknown>) => {
            calls.countFilters.push(filter);
            return overrides.count ?? 0;
          },
        }),
    ...(overrides.noPurge
      ? {}
      : {
          purgeByField:
            overrides.purge ??
            (async (field, value, strategy, options) => {
              calls.purgeArgs.push([field, value, strategy, options]);
              await options?.onProgress?.({ processed: 7 } as never);
              return { processed: 7, ok: true };
            }),
        }),
  };
  return { r, calls };
}

const spec = {
  id: 'demo.purge',
  resource: 'demo rows',
  parameter: 'subjectId',
  field: 'ownerId',
  strategy: { type: 'hard' } as const,
};

describe('definePurgeStep', () => {
  describe('declaration', () => {
    it('marks mutating strategies destructive and `skip` not', () => {
      const { r } = repo();
      expect(definePurgeStep(r, spec).destructive).toBe(true);
      expect(
        definePurgeStep(r, { ...spec, strategy: { type: 'anonymize', fields: { a: 'x' } } })
          .destructive,
      ).toBe(true);
      expect(
        definePurgeStep(r, { ...spec, strategy: { type: 'skip', reason: 'not applicable' } })
          .destructive,
      ).toBe(false);
    });

    it('surfaces the declared resource, retained note and warnings', async () => {
      const { r } = repo({ count: 4 });
      const step = definePurgeStep(r, {
        ...spec,
        retained: 'measures kept',
        warnings: ['irreversible'],
      });

      const estimate = await step.estimate(ctx(SCOPED));

      expect(estimate).toMatchObject({
        resource: 'demo rows',
        estimated: 4,
        retained: 'measures kept',
        warnings: ['irreversible'],
      });
    });

    it('counts using the declared match field and the sealed scope value', async () => {
      const { r, calls } = repo();
      await definePurgeStep(r, spec).estimate(ctx(SCOPED));
      expect(calls.countFilters).toEqual([{ ownerId: 'subject-1' }]);
    });
  });

  describe('fail-closed scoping', () => {
    it('BLOCKS and queries nothing when the scope parameter is absent', async () => {
      const { r, calls } = repo();
      const estimate = await definePurgeStep(r, spec).estimate(ctx());

      expect(estimate.blockers).toEqual([`${SCOPE_REQUIRED}:subjectId`]);
      // Critically: it must NOT fall back to an unscoped purge.
      expect(calls.countFilters).toEqual([]);
    });

    it('BLOCKS when the scope value is an empty string', async () => {
      const { r } = repo();
      const estimate = await definePurgeStep(r, spec).estimate(ctx({ subjectId: '' }));
      expect(estimate.blockers).toEqual([`${SCOPE_REQUIRED}:subjectId`]);
    });

    it('BLOCKS when the repository cannot purge', async () => {
      const { r } = repo({ noPurge: true });
      const estimate = await definePurgeStep(r, spec).estimate(ctx(SCOPED));
      expect(estimate.blockers).toEqual([`${REPOSITORY_UNAVAILABLE}:demo.purge`]);
    });

    it('BLOCKS when the repository is missing entirely', async () => {
      const estimate = await definePurgeStep(undefined, spec).estimate(ctx(SCOPED));
      expect(estimate.blockers).toEqual([`${REPOSITORY_UNAVAILABLE}:demo.purge`]);
    });

    it('refuses to execute an unscoped run even if the plan was bypassed', async () => {
      const { r, calls } = repo();
      const outcome = await definePurgeStep(r, spec).execute(ctx());

      expect(outcome).toMatchObject({ processed: 0, ok: false });
      expect(outcome.error).toContain('subjectId');
      expect(calls.purgeArgs).toEqual([]);
    });
  });

  describe('domain guards', () => {
    it('adds guard blockers alongside the estimate', async () => {
      const { r } = repo({ count: 2 });
      const step = definePurgeStep(r, {
        ...spec,
        guard: async (scope) => [`OPEN_WORK:${scope}`],
      });

      const estimate = await step.estimate(ctx(SCOPED));

      expect(estimate.blockers).toEqual(['OPEN_WORK:subject-1']);
      // The estimate still reports the real count so the operator sees scale.
      expect(estimate.estimated).toBe(2);
    });

    it('omits `blockers` entirely when the guard is satisfied', async () => {
      const { r } = repo();
      const step = definePurgeStep(r, { ...spec, guard: async () => [] });
      expect((await step.estimate(ctx(SCOPED))).blockers).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('passes field, scope and strategy through, and reports progress', async () => {
      const { r, calls } = repo();
      const onProgress = vi.fn();
      const strategy = { type: 'anonymize', fields: { email: '[redacted]' } } as const;

      const outcome = await definePurgeStep(r, { ...spec, strategy, batchSize: 50 }).execute({
        ...ctx(SCOPED),
        onProgress,
      });

      const [field, value, passedStrategy, options] = calls.purgeArgs[0] ?? [];
      expect(field).toBe('ownerId');
      expect(value).toBe('subject-1');
      expect(passedStrategy).toEqual(strategy);
      expect((options as { batchSize?: number })?.batchSize).toBe(50);
      expect(onProgress).toHaveBeenCalledWith({ resource: 'demo rows', processed: 7 });
      expect(outcome).toMatchObject({ processed: 7, ok: true });
    });

    it('probes cancellation BEFORE any write', async () => {
      const { r, calls } = repo();
      const throwIfCancelled = vi.fn(() => {
        throw new Error('cancelled');
      });

      await expect(
        definePurgeStep(r, spec).execute({ ...ctx(SCOPED), throwIfCancelled }),
      ).rejects.toThrow('cancelled');
      expect(calls.purgeArgs).toEqual([]);
    });

    it('threads the abort signal to the kit so a cancel lands between chunks', async () => {
      const { r, calls } = repo();
      const signal = new AbortController().signal;

      await definePurgeStep(r, spec).execute({ ...ctx(SCOPED), signal });

      expect((calls.purgeArgs[0]?.[3] as { signal?: AbortSignal })?.signal).toBe(signal);
    });

    it('reports ok:false when the kit reports failure — never claims success', async () => {
      const { r } = repo({
        purge: async () => ({ processed: 3, ok: false, error: { message: 'chunk 2 failed' } }),
      });

      const outcome = await definePurgeStep(r, spec).execute(ctx(SCOPED));

      expect(outcome).toMatchObject({ processed: 3, ok: false, error: 'chunk 2 failed' });
    });

    it('converts a thrown error into ok:false instead of propagating', async () => {
      const { r } = repo({
        purge: async () => {
          throw new Error('connection lost');
        },
      });

      expect(await definePurgeStep(r, spec).execute(ctx(SCOPED))).toMatchObject({
        processed: 0,
        ok: false,
        error: 'connection lost',
      });
    });
  });

  describe('verify', () => {
    it('passes only when nothing still matches', async () => {
      const { r } = repo({ count: 0 });
      const checks = await definePurgeStep(r, spec).verify?.(ctx(SCOPED));
      expect(checks?.[0]).toMatchObject({ name: 'demo.purge.verified', ok: true });
    });

    it('FAILS while rows survive — a processed count is not proof', async () => {
      const { r } = repo({ count: 5 });
      const checks = await definePurgeStep(r, spec).verify?.(ctx(SCOPED));
      expect(checks?.[0]?.ok).toBe(false);
      expect(checks?.[0]?.detail).toContain('5 row(s) still match');
    });

    it('uses `verifyFilter` when absence is proven by a different query', async () => {
      // An anonymize keyed on `_id` leaves the row in place, so absence must be
      // proven by querying the redacted identifier instead.
      const { r, calls } = repo({ count: 0 });
      const step = definePurgeStep(r, {
        ...spec,
        field: '_id',
        verifyFilter: (scope) => ({ email: scope }),
      });

      await step.verify?.(ctx(SCOPED));

      expect(calls.countFilters).toEqual([{ email: 'subject-1' }]);
    });

    it('FAILS rather than passing silently when it cannot verify', async () => {
      const { r } = repo({ noCount: true });
      const checks = await definePurgeStep(r, spec).verify?.(ctx(SCOPED));
      expect(checks?.[0]?.ok).toBe(false);
      expect(checks?.[0]?.detail).toContain('could not verify');
    });

    it('honours a custom check name', async () => {
      const { r } = repo();
      const step = definePurgeStep(r, { ...spec, verifyName: 'crm.contact.erased' });
      expect((await step.verify?.(ctx(SCOPED)))?.[0]?.name).toBe('crm.contact.erased');
    });
  });
});
