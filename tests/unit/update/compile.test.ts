import { describe, expect, it } from 'vitest';
import {
  compileUpdateSpecToMongo,
  compileUpdateSpecToSql,
  update,
} from '../../../src/update/index.js';

describe('compileUpdateSpecToMongo()', () => {
  it('emits $set for a set-only spec', () => {
    const out = compileUpdateSpecToMongo(update({ set: { status: 'active', version: 2 } }));
    expect(out).toEqual({ $set: { status: 'active', version: 2 } });
  });

  it('emits $unset with empty-string values per Mongo convention', () => {
    const out = compileUpdateSpecToMongo(update({ unset: ['lock', 'owner'] }));
    expect(out).toEqual({ $unset: { lock: '', owner: '' } });
  });

  it('emits $inc for numeric deltas', () => {
    const out = compileUpdateSpecToMongo(update({ inc: { attempts: 1, credits: -5 } }));
    expect(out).toEqual({ $inc: { attempts: 1, credits: -5 } });
  });

  it('emits $setOnInsert for upsert-only fields', () => {
    const out = compileUpdateSpecToMongo(update({ setOnInsert: { createdAt: 'now' } }));
    expect(out).toEqual({ $setOnInsert: { createdAt: 'now' } });
  });

  it('emits every bucket when all are populated', () => {
    const out = compileUpdateSpecToMongo(
      update({
        set: { status: 'pending' },
        unset: ['leaseOwner'],
        setOnInsert: { createdAt: 'now' },
        inc: { attempts: 1 },
      }),
    );
    expect(out).toEqual({
      $set: { status: 'pending' },
      $unset: { leaseOwner: '' },
      $setOnInsert: { createdAt: 'now' },
      $inc: { attempts: 1 },
    });
  });

  it('does not leak the internal op tag into the Mongo output', () => {
    const out = compileUpdateSpecToMongo(update({ set: { x: 1 } }));
    expect('op' in out).toBe(false);
  });

  it('clones buckets — caller mutation does not leak into the spec', () => {
    const spec = update({ set: { x: 1 } });
    const out = compileUpdateSpecToMongo(spec);
    (out.$set as Record<string, unknown>).x = 999;
    expect(spec.set?.x).toBe(1);
  });
});

describe('compileUpdateSpecToSql()', () => {
  it('maps set to data', () => {
    const plan = compileUpdateSpecToSql(update({ set: { status: 'active' } }));
    expect(plan.data).toEqual({ status: 'active' });
    expect(plan.unset).toEqual([]);
    expect(plan.inc).toEqual({});
    expect(plan.insertDefaults).toEqual({});
  });

  it('keeps unset, inc, insertDefaults on separate buckets', () => {
    const plan = compileUpdateSpecToSql(
      update({
        set: { status: 'pending' },
        unset: ['leaseOwner'],
        setOnInsert: { createdAt: 'now' },
        inc: { attempts: 1 },
      }),
    );
    expect(plan.data).toEqual({ status: 'pending' });
    expect(plan.unset).toEqual(['leaseOwner']);
    expect(plan.inc).toEqual({ attempts: 1 });
    expect(plan.insertDefaults).toEqual({ createdAt: 'now' });
  });

  it('freezes the plan so kits cannot mutate it', () => {
    const plan = compileUpdateSpecToSql(update({ set: { x: 1 } }));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.data)).toBe(true);
    expect(Object.isFrozen(plan.unset)).toBe(true);
    expect(Object.isFrozen(plan.inc)).toBe(true);
    expect(Object.isFrozen(plan.insertDefaults)).toBe(true);
  });

  it('clones so caller mutation does not leak into the spec', () => {
    const spec = update({ set: { x: 1 }, inc: { n: 1 } });
    const plan = compileUpdateSpecToSql(spec);
    // plan buckets are frozen — just confirm the source spec stays intact.
    expect(spec.set).toEqual({ x: 1 });
    expect(spec.inc).toEqual({ n: 1 });
    expect(plan.data).not.toBe(spec.set);
    expect(plan.inc).not.toBe(spec.inc);
  });
});
