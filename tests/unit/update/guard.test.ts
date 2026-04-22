import { describe, expect, it } from 'vitest';
import { isUpdatePipeline, isUpdateSpec, setFields } from '../../../src/update/index.js';

describe('isUpdateSpec()', () => {
  it('accepts a built UpdateSpec', () => {
    expect(isUpdateSpec(setFields({ x: 1 }))).toBe(true);
  });

  it('rejects a raw Mongo operator record — that is the kit-native form', () => {
    expect(isUpdateSpec({ $set: { x: 1 } })).toBe(false);
  });

  it('rejects a Mongo aggregation pipeline', () => {
    expect(isUpdateSpec([{ $set: { x: 1 } }])).toBe(false);
  });

  it('rejects primitives, null, undefined', () => {
    expect(isUpdateSpec(null)).toBe(false);
    expect(isUpdateSpec(undefined)).toBe(false);
    expect(isUpdateSpec('update')).toBe(false);
    expect(isUpdateSpec(42)).toBe(false);
    expect(isUpdateSpec(true)).toBe(false);
  });

  it('rejects an object with op !== "update"', () => {
    expect(isUpdateSpec({ op: 'set', fields: { x: 1 } })).toBe(false);
  });
});

describe('isUpdatePipeline()', () => {
  it('accepts a Mongo aggregation pipeline array', () => {
    expect(isUpdatePipeline([{ $set: { x: 1 } }])).toBe(true);
  });

  it('accepts an empty array (Mongo no-op pipeline)', () => {
    expect(isUpdatePipeline([])).toBe(true);
  });

  it('rejects an UpdateSpec', () => {
    expect(isUpdatePipeline(setFields({ x: 1 }))).toBe(false);
  });

  it('rejects a plain record', () => {
    expect(isUpdatePipeline({ $set: { x: 1 } })).toBe(false);
  });
});
