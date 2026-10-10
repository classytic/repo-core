/**
 * Read-model properties (fast-check), gated by `RepoCapabilities.readModel`.
 *
 * For random increments with random replays: the incremental model equals the source (no drift,
 * a replay never double-counts); a rebuild from the source keeps zero drift; and corrupting one
 * grain yields EXACTLY one drift row, naming that grain. An undeclared capability is a skipped
 * group naming it; a declared one without a fixture fails.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RepoCapabilities } from '../repository/capabilities.js';
import type { ReadModelFixture } from './data-access-conformance.js';

export interface ReadModelPropertyHarness {
  name: string;
  features: RepoCapabilities;
  fixture?: () => Promise<ReadModelFixture>;
  /** fast-check runs. Default 15. */
  numRuns?: number;
}

const eventArb = fc.record({
  period: fc.constantFrom('2026-01', '2026-02', '2026-03'),
  rate: fc.constantFrom(0, 5, 15),
  tax: fc.integer({ min: 1, max: 1000 }),
});

export function runReadModelPropertyConformance(harness: ReadModelPropertyHarness): void {
  const title = `[read-model properties] ${harness.name}`;
  if (harness.features.readModel !== true) {
    describe.skip(`${title} [skipped: capability 'readModel' not declared]`, () => {
      it('skipped', () => undefined);
    });
    return;
  }
  describe(title, () => {
    if (!harness.fixture) {
      it("declares 'readModel' and supplies its fixture", () => {
        throw new Error(`${harness.name} declares 'readModel' but supplies no fixture`);
      });
      return;
    }
    const make = harness.fixture;

    it('increments with replays equal the source; rebuild keeps zero drift; one corruption is one drift row', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(eventArb, { minLength: 1, maxLength: 20 }),
          fc.array(fc.nat(), { maxLength: 10 }),
          fc.nat(),
          async (events, replayPicks, corruptPick) => {
            const f = await make();
            try {
              const tenant = 't-prop';
              const keyed = events.map((e, i) => ({ ...e, dedupeKey: `e${i}` }));
              await f.seedSource(tenant, events);
              // Deliver in two batches, the second replaying random earlier events.
              const replays = replayPicks
                .map((p) => keyed[p % keyed.length])
                .filter((x) => x !== undefined);
              const half = Math.ceil(keyed.length / 2);
              await f.applyIncrements(tenant, keyed.slice(0, half));
              await f.applyIncrements(tenant, [...replays, ...keyed.slice(half)]);
              expect(await f.reconcile(tenant)).toEqual([]);

              await f.rebuild(tenant);
              expect(await f.reconcile(tenant)).toEqual([]);

              const grains = await f.readTotals(tenant);
              const target = grains[corruptPick % grains.length];
              if (!target) throw new Error('no grain to corrupt');
              await f.tamper(tenant, target.period, target.rate);
              const drift = await f.reconcile(tenant);
              expect(drift).toHaveLength(1);
              expect(drift[0]?.key).toMatchObject({ period: target.period, rate: target.rate });
            } finally {
              await f.cleanup();
            }
          },
        ),
        { numRuns: harness.numRuns ?? 15 },
      );
    });
  });
}
