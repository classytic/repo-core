import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  validateCursorSort,
  validateCursorVersion,
} from '../../../src/pagination/index.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a single-field sort with date primary value', () => {
    const doc = { _id: 'id1', createdAt: new Date('2026-04-19T00:00:00Z') };
    const token = encodeCursor(doc, 'createdAt', { createdAt: -1, _id: -1 });

    const decoded = decodeCursor(token);
    expect(decoded.value).toEqual(new Date('2026-04-19T00:00:00Z'));
    expect(decoded.id).toBe('id1');
    expect(decoded.sort).toEqual({ createdAt: -1, _id: -1 });
    expect(decoded.version).toBe(1);
    expect(decoded.values).toBeUndefined();
  });

  it('round-trips a compound sort — values map is populated', () => {
    const doc = { _id: 'id1', priority: 3, createdAt: new Date('2026-01-01T00:00:00Z') };
    const sort = { priority: -1, createdAt: -1, _id: -1 } as const;
    const token = encodeCursor(doc, 'priority', sort);

    const decoded = decodeCursor(token);
    expect(decoded.values).toEqual({
      priority: 3,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('emits URL-safe base64 — no +, /, or = in the token', () => {
    // Use a doc whose payload is large enough to force base64 chars that
    // would differ between standard and URL-safe encoding.
    const doc = { _id: 'a-very-long-id-value-xxxxxxxxxxxxxxxxxxxxxxx', x: 123 };
    const token = encodeCursor(doc, 'x', { x: 1, _id: 1 });
    expect(token).not.toMatch(/[+/=]/);
  });

  it('decodes legacy standard-base64 tokens (mongokit ≤3.x compat)', () => {
    // Synthesize a standard-base64 token the way mongokit's Buffer.from().toString('base64') would.
    const payload = {
      v: 42,
      t: 'number',
      id: 'abc',
      idType: 'string',
      sort: { x: 1, _id: 1 },
      ver: 1,
    };
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const standardBase64 = globalThis.btoa(binary); // includes +, /, = if needed

    const decoded = decodeCursor(standardBase64);
    expect(decoded.value).toBe(42);
    expect(decoded.id).toBe('abc');
  });

  it('treats unknown type tags as strings (e.g. mongokit objectid → string)', () => {
    const doc = { _id: 'abc', x: 'value' };
    const token = encodeCursor(doc, 'x', { x: 1, _id: 1 }, 1, () => 'objectid');
    const decoded = decodeCursor(token);
    expect(decoded.value).toBe('value');
    expect(decoded.id).toBe('abc');
  });

  it('rejects malformed tokens with a readable message', () => {
    expect(() => decodeCursor('not!base64!')).toThrow(/base64|JSON|payload/);
    expect(() => decodeCursor('eyJub3QiOiJ2YWxpZCJ9')).toThrow(/malformed payload/);
  });
});

describe('validateCursorSort', () => {
  it('passes when sorts are structurally equal', () => {
    expect(() =>
      validateCursorSort({ createdAt: -1, _id: -1 }, { createdAt: -1, _id: -1 }),
    ).not.toThrow();
  });

  it('throws when sort fields differ', () => {
    expect(() => validateCursorSort({ createdAt: -1 }, { updatedAt: -1 })).toThrow(
      'Cursor sort does not match',
    );
  });

  it('throws when directions differ', () => {
    expect(() => validateCursorSort({ createdAt: -1 }, { createdAt: 1 })).toThrow();
  });

  it('detects key-order drift — JSON-based comparison is strict', () => {
    // Strict equality protects against silently resuming at wrong position
    // when a sort key-order changes server-side across deploys.
    expect(() => validateCursorSort({ a: 1, b: 1 } as never, { b: 1, a: 1 } as never)).toThrow();
  });
});

describe('validateCursorVersion', () => {
  it('passes when cursor version matches expected', () => {
    expect(() => validateCursorVersion(1, 1)).not.toThrow();
  });

  it('rejects cursors newer than expected (client ahead of server)', () => {
    expect(() => validateCursorVersion(3, 2)).toThrow(/newer than expected/);
  });

  it('rejects cursors older than minVersion — forces restart after breaking change', () => {
    expect(() => validateCursorVersion(1, 3, 2)).toThrow(/older than minimum/);
  });

  it('accepts cursors between min and expected', () => {
    expect(() => validateCursorVersion(2, 3, 1)).not.toThrow();
  });
});
