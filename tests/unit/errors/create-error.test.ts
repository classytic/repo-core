import { describe, expect, it } from 'vitest';
import {
  conservativeMongoIsDuplicateKey,
  createError,
  isHttpError,
  toDuplicateKeyHttpError,
} from '../../../src/errors/index.js';

describe('createError', () => {
  it('returns an Error with a status property', () => {
    const err = createError(404, 'Not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not found');
  });

  it('preserves stack trace', () => {
    const err = createError(400, 'Bad input');
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });
});

describe('isHttpError', () => {
  it('recognizes errors built by createError', () => {
    expect(isHttpError(createError(500, 'boom'))).toBe(true);
  });

  it('rejects plain Error without status', () => {
    expect(isHttpError(new Error('plain'))).toBe(false);
  });

  it('rejects non-errors even with a status field', () => {
    expect(isHttpError({ status: 500, message: 'not an error' })).toBe(false);
    expect(isHttpError(null)).toBe(false);
    expect(isHttpError('nope')).toBe(false);
  });

  it('rejects errors with non-numeric status', () => {
    const e = Object.assign(new Error('x'), { status: 'five hundred' });
    expect(isHttpError(e)).toBe(false);
  });
});

describe('conservativeMongoIsDuplicateKey', () => {
  it('matches code 11000', () => {
    expect(conservativeMongoIsDuplicateKey({ code: 11000 })).toBe(true);
  });

  it('matches codeName DuplicateKey', () => {
    expect(conservativeMongoIsDuplicateKey({ codeName: 'DuplicateKey' })).toBe(true);
  });

  it('rejects generic Mongo errors like WriteConflict (112) — not a duplicate key', () => {
    expect(conservativeMongoIsDuplicateKey({ code: 112 })).toBe(false);
    expect(conservativeMongoIsDuplicateKey({ code: 10107 })).toBe(false); // NotWritablePrimary
  });

  it('rejects Prisma P2002 / Postgres 23505 — kits implement their own predicates', () => {
    expect(conservativeMongoIsDuplicateKey({ code: 'P2002' })).toBe(false);
    expect(conservativeMongoIsDuplicateKey({ code: '23505' })).toBe(false);
  });

  it('handles non-error values without throwing', () => {
    expect(conservativeMongoIsDuplicateKey(null)).toBe(false);
    expect(conservativeMongoIsDuplicateKey(undefined)).toBe(false);
    expect(conservativeMongoIsDuplicateKey('oops')).toBe(false);
  });
});

describe('toDuplicateKeyHttpError', () => {
  it('produces a 409 with field names in the message (PII-safe default)', () => {
    const err = toDuplicateKeyHttpError({ fields: ['email'], values: { email: 'pii@x.com' } });
    expect(err.status).toBe(409);
    expect(err.message).toBe('Duplicate value for email');
    expect(err.duplicate?.fields).toEqual(['email']);
    expect(err.duplicate?.values).toBeUndefined();
  });

  it('includes values when exposeValues: true', () => {
    const err = toDuplicateKeyHttpError(
      { fields: ['email'], values: { email: 'user@x.com' } },
      { exposeValues: true },
    );
    expect(err.message).toContain('email: "user@x.com"');
    expect(err.duplicate?.values).toEqual({ email: 'user@x.com' });
  });

  it('falls back to a generic message when fields are empty', () => {
    const err = toDuplicateKeyHttpError({ fields: [] });
    expect(err.message).toBe('Duplicate key error');
  });
});
