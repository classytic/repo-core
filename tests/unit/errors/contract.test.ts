/**
 * `toErrorContract` + `statusToErrorCode` + `ERROR_CODES` tests.
 *
 * Pinned contract:
 *   1. `ERROR_CODES` matches the documented org-wide canonical codes
 *      (lowercase + snake_case, RFC 7807 / Stripe style).
 *   2. `statusToErrorCode` maps well-known HTTP statuses to canonical
 *      codes; unmapped statuses fall through to `'internal_error'` so
 *      domain handlers explicitly opt into the right code.
 *   3. `toErrorContract` produces a valid {@link ErrorContract} from any
 *      `Error`, `HttpError`, or non-Error value:
 *        - `error.code` wins over status-derived code.
 *        - `validationErrors` flatten into `details[]`.
 *        - `duplicate.fields` flatten into `details[]` with
 *          `code: 'duplicate_key'`.
 *        - `meta` flows through.
 *        - Plain `Error` without `status` produces a 500 / internal_error
 *          contract — the wire never sees a thrown `undefined`.
 *
 * History: error contract types previously lived in
 * `@classytic/primitives/errors`; relocated here in repo-core 0.3.x
 * because errors are infrastructure-shaped (HTTP-coupled). Same
 * playbook as the pagination + tenant relocations.
 */

import { describe, expect, it } from 'vitest';
import { statusToErrorCode, toErrorContract } from '../../../src/errors/contract.js';
import { createError } from '../../../src/errors/create-error.js';
import { ERROR_CODES, type HttpError } from '../../../src/errors/types.js';

describe('ERROR_CODES — canonical org-wide codes', () => {
  it('matches the documented canonical lowercase set', () => {
    expect(ERROR_CODES).toEqual({
      VALIDATION: 'validation_error',
      NOT_FOUND: 'not_found',
      CONFLICT: 'conflict',
      UNAUTHORIZED: 'unauthorized',
      FORBIDDEN: 'forbidden',
      RATE_LIMITED: 'rate_limited',
      IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
      PRECONDITION_FAILED: 'precondition_failed',
      INTERNAL: 'internal_error',
      UNAVAILABLE: 'service_unavailable',
      TIMEOUT: 'timeout',
    });
  });
});

describe('statusToErrorCode', () => {
  it('maps well-known statuses', () => {
    expect(statusToErrorCode(400)).toBe('validation_error');
    expect(statusToErrorCode(401)).toBe('unauthorized');
    expect(statusToErrorCode(403)).toBe('forbidden');
    expect(statusToErrorCode(404)).toBe('not_found');
    expect(statusToErrorCode(409)).toBe('conflict');
    expect(statusToErrorCode(412)).toBe('precondition_failed');
    expect(statusToErrorCode(429)).toBe('rate_limited');
    expect(statusToErrorCode(503)).toBe('service_unavailable');
    expect(statusToErrorCode(504)).toBe('timeout');
  });

  it('falls through to internal_error for unmapped statuses', () => {
    expect(statusToErrorCode(500)).toBe('internal_error');
    expect(statusToErrorCode(422)).toBe('internal_error');
    expect(statusToErrorCode(418)).toBe('internal_error');
  });
});

describe('toErrorContract', () => {
  it('produces a contract from a basic HttpError', () => {
    const err = createError(404, 'Document not found');
    const contract = toErrorContract(err);
    expect(contract).toEqual({
      code: 'not_found',
      message: 'Document not found',
      status: 404,
    });
  });

  it('uses error.code when set (preferred over status-derived)', () => {
    const err = Object.assign(new Error('Custom code'), {
      status: 422,
      code: 'order.validation.missing_line',
    }) as HttpError;
    const contract = toErrorContract(err);
    expect(contract.code).toBe('order.validation.missing_line');
    expect(contract.message).toBe('Custom code');
    expect(contract.status).toBe(422);
  });

  it('flattens validationErrors into details[]', () => {
    const err = Object.assign(new Error('Validation failed'), {
      status: 400,
      validationErrors: [
        { validator: 'required', error: 'name is required' },
        { validator: 'minLength', error: 'name too short' },
      ],
    }) as HttpError;
    const contract = toErrorContract(err);
    expect(contract.details).toEqual([
      { code: 'required', message: 'name is required' },
      { code: 'minLength', message: 'name too short' },
    ]);
  });

  it('flattens duplicate.fields into details[] with duplicate_key code', () => {
    const err = Object.assign(new Error('Duplicate'), {
      status: 409,
      duplicate: { fields: ['email', 'username'] },
    }) as HttpError;
    const contract = toErrorContract(err);
    expect(contract.details).toEqual([
      { path: 'email', code: 'duplicate_key', message: 'Duplicate value for "email"' },
      { path: 'username', code: 'duplicate_key', message: 'Duplicate value for "username"' },
    ]);
    expect(contract.code).toBe('conflict');
  });

  it('threads meta through unchanged', () => {
    const err = Object.assign(new Error('Search misconfigured'), {
      status: 400,
      code: 'SEARCH_NOT_CONFIGURED',
      meta: { model: 'Customer', availableModes: ['text', 'regex'] },
    }) as HttpError;
    const contract = toErrorContract(err);
    expect(contract.meta).toEqual({
      model: 'Customer',
      availableModes: ['text', 'regex'],
    });
  });

  it('handles plain Error without status — emits 500 / internal_error', () => {
    const err = new Error('boom');
    const contract = toErrorContract(err);
    expect(contract).toEqual({
      code: 'internal_error',
      message: 'boom',
      status: 500,
    });
  });

  it('handles non-Error throwables (string)', () => {
    const contract = toErrorContract('something went wrong');
    expect(contract).toEqual({
      code: 'internal_error',
      message: 'something went wrong',
      status: 500,
    });
  });

  it('handles non-Error throwables (object with no message)', () => {
    const contract = toErrorContract({ random: 'object' });
    expect(contract.code).toBe('internal_error');
    expect(contract.status).toBe(500);
  });

  it('omits empty validationErrors / duplicate fields from details', () => {
    const err = Object.assign(new Error('Plain'), {
      status: 400,
      validationErrors: [],
      duplicate: { fields: [] },
    }) as HttpError;
    const contract = toErrorContract(err);
    expect(contract.details).toBeUndefined();
  });

  it('uses message fallback when error.message is empty', () => {
    const err = Object.assign(new Error(''), { status: 500 }) as HttpError;
    const contract = toErrorContract(err);
    expect(contract.message).toBe('Internal error');
  });
});

describe('toErrorContract — round-trip with createError', () => {
  it('produces canonical codes for each createError(status, ...) usage', () => {
    expect(toErrorContract(createError(400, 'a')).code).toBe('validation_error');
    expect(toErrorContract(createError(401, 'a')).code).toBe('unauthorized');
    expect(toErrorContract(createError(404, 'a')).code).toBe('not_found');
    expect(toErrorContract(createError(409, 'a')).code).toBe('conflict');
    expect(toErrorContract(createError(429, 'a')).code).toBe('rate_limited');
  });
});
