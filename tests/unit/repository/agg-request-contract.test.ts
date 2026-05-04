/**
 * Type-level contract tests for `AggRequest`.
 *
 * Pins the public shape so:
 *   - existing aggregate callers (no `lookups`) stay valid (additive change)
 *   - hosts using the new `lookups` field type-check against `LookupSpec`
 *   - dotted-path strings (`'category.parent'`) are valid `groupBy` /
 *     measure.field values (string-typed; runtime validation is the kit's
 *     job)
 *
 * No runtime assertions — these compile-time checks fail the test file
 * with type errors if the contract regresses.
 */

import { describe, expect, it } from 'vitest';
import type { LookupSpec } from '../../../src/lookup/types.js';
import type { AggRequest, AggResult } from '../../../src/repository/types.js';

describe('AggRequest — type contract', () => {
  it('accepts the pre-lookups shape (existing aggregate callers stay valid)', () => {
    const req: AggRequest = {
      filter: { status: 'active' },
      groupBy: 'category',
      measures: {
        count: { op: 'count' },
        revenue: { op: 'sum', field: 'totalPrice' },
      },
      sort: { revenue: -1 },
      limit: 100,
    };
    expect(req.measures.count?.op).toBe('count');
  });

  it('accepts `lookups: LookupSpec[]` for joined aggregates', () => {
    const lookups: LookupSpec[] = [
      {
        from: 'category',
        localField: 'categoryId',
        foreignField: '_id',
        as: 'category',
        single: true,
        select: ['name', 'parent'],
      },
    ];
    const req: AggRequest = {
      filter: { archived: false },
      lookups,
      groupBy: 'category.parent', // dotted path into joined alias
      measures: {
        revenue: { op: 'sum', field: 'totalPrice' },
      },
      sort: { revenue: -1 },
      limit: 10,
    };
    expect(req.lookups?.[0]?.from).toBe('category');
  });

  it('accepts dotted-path `measure.field` references into joined aliases', () => {
    const req: AggRequest = {
      lookups: [{ from: 'product', localField: 'productId', foreignField: '_id', as: 'product' }],
      groupBy: 'sellerId',
      measures: {
        // `product.basePrice` references a field on the joined `product` row
        avgBasePrice: { op: 'avg', field: 'product.basePrice' },
      },
    };
    expect(req.measures.avgBasePrice?.op).toBe('avg');
  });

  it('lookups field is optional (existing scalar aggregations unaffected)', () => {
    // Scalar aggregation without groupBy / lookups
    const req: AggRequest = {
      measures: { total: { op: 'sum', field: 'amount' } },
    };
    expect(req.lookups).toBeUndefined();
  });

  it('AggResult shape is unchanged by the lookups addition', () => {
    const result: AggResult = { rows: [{ status: 'active', count: 42 }] };
    expect(result.rows.length).toBe(1);
  });
});
