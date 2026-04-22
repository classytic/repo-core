import { describe, expect, it } from 'vitest';
import type { UpdateSpec } from '../../../src/update/index.js';
import {
  combineUpdates,
  incFields,
  setFields,
  setOnInsertFields,
  unsetFields,
  update,
} from '../../../src/update/index.js';

describe('update() root builder', () => {
  it('builds a frozen spec with the discriminant tag', () => {
    const spec = update({ set: { status: 'active' } });
    expect(spec.op).toBe('update');
    expect(spec.set).toEqual({ status: 'active' });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.set)).toBe(true);
  });

  it('carries every populated bucket', () => {
    const spec = update({
      set: { status: 'pending' },
      unset: ['lock'],
      setOnInsert: { createdAt: 'now' },
      inc: { attempts: 1 },
    });
    expect(spec).toEqual({
      op: 'update',
      set: { status: 'pending' },
      unset: ['lock'],
      setOnInsert: { createdAt: 'now' },
      inc: { attempts: 1 },
    });
  });

  it('omits empty buckets', () => {
    const spec = update({ set: { x: 1 } });
    expect(spec).toEqual({ op: 'update', set: { x: 1 } });
    expect('unset' in spec).toBe(false);
    expect('inc' in spec).toBe(false);
    expect('setOnInsert' in spec).toBe(false);
  });

  it('strips undefined from set — the spread-optional footgun', () => {
    const spec = update({ set: { a: 1, b: undefined, c: 'x' } });
    // `b` is dropped; the caller who wants to clear a field uses `unset`.
    expect(spec.set).toEqual({ a: 1, c: 'x' });
  });

  it('strips undefined from setOnInsert', () => {
    const spec = update({ setOnInsert: { a: 1, b: undefined } });
    expect(spec.setOnInsert).toEqual({ a: 1 });
  });

  it('drops set entirely when every value is undefined', () => {
    const spec = update({
      set: { a: undefined, b: undefined },
      unset: ['x'],
    });
    expect('set' in spec).toBe(false);
    expect(spec.unset).toEqual(['x']);
  });

  it('treats empty unset array as absent', () => {
    const spec = update({ set: { x: 1 }, unset: [] });
    expect('unset' in spec).toBe(false);
  });

  it('throws when every bucket is empty', () => {
    expect(() => update({})).toThrow(/empty/i);
    expect(() => update({ set: {} })).toThrow(/empty/i);
    expect(() => update({ set: { a: undefined } })).toThrow(/empty/i);
    expect(() => update({ unset: [] })).toThrow(/empty/i);
  });
});

describe('single-mutation shorthands', () => {
  it('setFields wraps set-only updates', () => {
    const spec = setFields({ status: 'active' });
    expect(spec).toEqual({ op: 'update', set: { status: 'active' } });
  });

  it('unsetFields takes varargs', () => {
    const spec = unsetFields('lock', 'owner');
    expect(spec).toEqual({ op: 'update', unset: ['lock', 'owner'] });
  });

  it('incFields wraps inc-only updates', () => {
    const spec = incFields({ attempts: 1, priority: -2 });
    expect(spec).toEqual({ op: 'update', inc: { attempts: 1, priority: -2 } });
  });

  it('setOnInsertFields wraps setOnInsert-only updates', () => {
    const spec = setOnInsertFields({ createdAt: 'now' });
    expect(spec).toEqual({ op: 'update', setOnInsert: { createdAt: 'now' } });
  });
});

describe('combineUpdates()', () => {
  it('returns the single spec unchanged when only one passed', () => {
    const a = setFields({ x: 1 });
    expect(combineUpdates(a)).toBe(a);
  });

  it('merges buckets; later set/inc/setOnInsert keys win', () => {
    const a = update({ set: { x: 1, y: 2 }, inc: { n: 1 } });
    const b = update({ set: { y: 99 }, inc: { n: 10 } });
    const merged = combineUpdates(a, b);
    expect(merged.set).toEqual({ x: 1, y: 99 });
    expect(merged.inc).toEqual({ n: 10 });
  });

  it('concatenates unset arrays and de-duplicates', () => {
    const a = unsetFields('lock', 'owner');
    const b = unsetFields('owner', 'expiresAt');
    const merged = combineUpdates(a, b);
    expect(merged.unset).toEqual(['lock', 'owner', 'expiresAt']);
  });

  it('keeps setOnInsert separate from set', () => {
    const a = setFields({ x: 1 });
    const b = setOnInsertFields({ createdAt: 'now' });
    const merged = combineUpdates(a, b) as UpdateSpec;
    expect(merged.set).toEqual({ x: 1 });
    expect(merged.setOnInsert).toEqual({ createdAt: 'now' });
  });

  it('throws on empty input', () => {
    expect(() => combineUpdates()).toThrow(/at least one/i);
  });
});
