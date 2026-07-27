/**
 * `runPurgeConformance` — cross-kit chunked-purge contract suite.
 *
 * Proves a kit's `purgeByField`/`purgeByFilter` port makes **stable
 * progress for EVERY strategy** when the match set exceeds `batchSize`
 * — the exact property the naive "re-query the same predicate" port
 * shape violates: `hard` self-advances (deleted rows leave the match
 * set) but `soft`/`anonymize` re-select the same first chunk forever
 * because the mutated rows still satisfy the base predicate.
 *
 * Every scenario seeds MORE rows than `batchSize`, so a port without
 * keyset progression fails here instead of hanging production. A chunk
 * budget (via `onProgress` + abort) converts the would-be infinite loop
 * into a crisp assertion failure.
 *
 * ## Usage from a kit
 *
 *     import { runPurgeConformance } from '@classytic/repo-core/testing';
 *
 *     describe('mongokit purge conformance', () => {
 *       runPurgeConformance({
 *         name: 'mongokit',
 *         async setup() { …return a PurgeConformanceContext… },
 *       });
 *     });
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  TenantPurgeOptions,
  TenantPurgeResult,
  TenantPurgeStrategy,
} from '../repository/types.js';

/** Everything the shared scenarios need from a kit. */
export interface PurgeConformanceContext {
  /**
   * Seed `inScope` docs matching the purge scope and `outOfScope` docs
   * outside it. Every in-scope doc must carry:
   *   - a string field `email` set to `'user-<i>@test.local'` (anonymize target);
   *   - a numeric field `amount` (a measure that must SURVIVE soft/anonymize).
   */
  seed(inScope: number, outOfScope: number): Promise<void>;
  /** Run the kit's chunked purge over the bound scope. */
  purge(strategy: TenantPurgeStrategy, options?: TenantPurgeOptions): Promise<TenantPurgeResult>;
  /** RAW physical count of in-scope rows — MUST bypass soft-delete query filters. */
  countRaw(): Promise<number>;
  /** RAW count of in-scope rows carrying the soft-deleted flag. */
  countSoftFlagged(): Promise<number>;
  /** RAW count of in-scope rows whose `email` equals `value`. */
  countEmail(value: string): Promise<number>;
  /** RAW sum of `amount` across in-scope rows (proves measures retained). */
  sumAmount(): Promise<number>;
  /** RAW physical count of OUT-of-scope rows — must never change. */
  countOutOfScope(): Promise<number>;
}

export interface PurgeConformanceHarness {
  /** Kit name — the top-level describe() label. */
  name: string;
  /** Fresh isolated context per test (own collection/table). */
  setup(): Promise<PurgeConformanceContext>;
}

const IN_SCOPE = 25;
const OUT_SCOPE = 5;
const BATCH = 10; // 25/10 ⇒ chunks [10, 10, 5]
const AMOUNT_EACH = 7;

/**
 * Wrap TenantPurgeOptions with a chunk budget: when the port stops
 * progressing, the loop would otherwise run forever — the budget aborts
 * it after `limit` chunks so the suite fails with a readable assertion
 * instead of a vitest timeout.
 */
function budgeted(limit: number, chunks: number[] = []): TenantPurgeOptions {
  const controller = new AbortController();
  return {
    batchSize: BATCH,
    signal: controller.signal,
    onProgress({ chunkSize }) {
      chunks.push(chunkSize);
      if (chunks.length >= limit) controller.abort();
    },
  };
}

/** ceil(25/10) + 1 slack — a progressing port never needs more. */
const CHUNK_BUDGET = Math.ceil(IN_SCOPE / BATCH) + 1;

export function runPurgeConformance(harness: PurgeConformanceHarness): void {
  describe(`${harness.name} — chunked purge conformance`, () => {
    let ctx: PurgeConformanceContext;

    beforeEach(async () => {
      ctx = await harness.setup();
    });

    it('hard: drains a multi-batch scope exactly once per row', async () => {
      await ctx.seed(IN_SCOPE, OUT_SCOPE);
      const chunks: number[] = [];
      const res = await ctx.purge({ type: 'hard' }, budgeted(CHUNK_BUDGET, chunks));

      expect(res.ok).toBe(true);
      expect(res.processed).toBe(IN_SCOPE);
      expect(chunks).toEqual([10, 10, 5]);
      expect(await ctx.countRaw()).toBe(0);
      expect(await ctx.countOutOfScope()).toBe(OUT_SCOPE);
    });

    it('soft: progresses across batches WITHOUT caller-supplied exclusion predicates', async () => {
      await ctx.seed(IN_SCOPE, OUT_SCOPE);
      const chunks: number[] = [];
      const res = await ctx.purge({ type: 'soft' }, budgeted(CHUNK_BUDGET, chunks));

      // A port lacking keyset progression re-selects the first 10 rows
      // forever: the budget aborts it with ok:false and processed > 25.
      expect(res.ok).toBe(true);
      expect(res.processed).toBe(IN_SCOPE);
      expect(chunks).toEqual([10, 10, 5]);

      // Rows are flagged, physically retained, measures intact.
      expect(await ctx.countRaw()).toBe(IN_SCOPE);
      expect(await ctx.countSoftFlagged()).toBe(IN_SCOPE);
      expect(await ctx.sumAmount()).toBe(IN_SCOPE * AMOUNT_EACH);
      expect(await ctx.countOutOfScope()).toBe(OUT_SCOPE);
    });

    it('anonymize (static): progresses across batches and retains measures', async () => {
      await ctx.seed(IN_SCOPE, OUT_SCOPE);
      const chunks: number[] = [];
      const res = await ctx.purge(
        { type: 'anonymize', fields: { email: 'redacted@example.invalid' } },
        budgeted(CHUNK_BUDGET, chunks),
      );

      expect(res.ok).toBe(true);
      expect(res.processed).toBe(IN_SCOPE);
      expect(chunks).toEqual([10, 10, 5]);
      expect(await ctx.countEmail('redacted@example.invalid')).toBe(IN_SCOPE);
      expect(await ctx.sumAmount()).toBe(IN_SCOPE * AMOUNT_EACH);
      expect(await ctx.countRaw()).toBe(IN_SCOPE);
      expect(await ctx.countOutOfScope()).toBe(OUT_SCOPE);
    });

    it('anonymize (function-form): progresses across batches', async () => {
      await ctx.seed(IN_SCOPE, OUT_SCOPE);
      const res = await ctx.purge(
        {
          type: 'anonymize',
          fields: { email: () => 'fn-redacted@example.invalid' },
        },
        budgeted(CHUNK_BUDGET),
      );

      expect(res.ok).toBe(true);
      expect(res.processed).toBe(IN_SCOPE);
      expect(await ctx.countEmail('fn-redacted@example.invalid')).toBe(IN_SCOPE);
      expect(await ctx.sumAmount()).toBe(IN_SCOPE * AMOUNT_EACH);
    });

    it('exact-batch boundary: inScope === batchSize processes each row once', async () => {
      await ctx.seed(BATCH, OUT_SCOPE);
      const res = await ctx.purge({ type: 'soft' }, budgeted(CHUNK_BUDGET));

      expect(res.ok).toBe(true);
      expect(res.processed).toBe(BATCH);
      expect(await ctx.countSoftFlagged()).toBe(BATCH);
    });

    it('skip: declared no-op reaches no rows', async () => {
      await ctx.seed(3, 0);
      const res = await ctx.purge({ type: 'skip', reason: 'retention-owned' });

      expect(res.ok).toBe(true);
      expect(res.processed).toBe(0);
      expect(res.skipReason).toBe('retention-owned');
      expect(await ctx.countRaw()).toBe(3);
    });

    it('empty scope: terminates immediately with zero processed', async () => {
      await ctx.seed(0, OUT_SCOPE);
      const res = await ctx.purge({ type: 'hard' }, budgeted(CHUNK_BUDGET));

      expect(res.ok).toBe(true);
      expect(res.processed).toBe(0);
      expect(await ctx.countOutOfScope()).toBe(OUT_SCOPE);
    });

    it('abort between chunks: committed chunks stay, result is ok:false', async () => {
      await ctx.seed(IN_SCOPE, OUT_SCOPE);
      const controller = new AbortController();
      const res = await ctx.purge(
        { type: 'hard' },
        {
          batchSize: BATCH,
          signal: controller.signal,
          onProgress() {
            controller.abort(); // fire after the FIRST committed chunk
          },
        },
      );

      expect(res.ok).toBe(false);
      expect(res.processed).toBe(BATCH);
      expect(await ctx.countRaw()).toBe(IN_SCOPE - BATCH);
    });
  });
}
