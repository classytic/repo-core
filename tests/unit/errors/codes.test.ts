/**
 * The wire error-code catalog — the vocabulary servers emit and client SDKs
 * switch on. Values are wire-stable; this pins their shape so a malformed or
 * duplicated addition fails here rather than in a client's `switch`.
 */

import { describe, expect, it } from 'vitest';
import {
  ARC_ERROR_CODES,
  ARC_REASON_CODES,
  DUPLICATE_KEY_DETAIL_CODE,
  ERROR_CODES,
  statusToErrorCode,
} from '../../../src/errors/index.js';

const all = [
  ...Object.values(ERROR_CODES),
  ...Object.values(ARC_ERROR_CODES),
  ...Object.values(ARC_REASON_CODES),
];

describe('error-code catalog', () => {
  it('no value appears twice across families', () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it('cross-cutting codes are lowercase snake_case', () => {
    for (const code of Object.values(ERROR_CODES)) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('arc codes are `arc.` + lowercase dot/snake segments', () => {
    for (const code of Object.values(ARC_ERROR_CODES)) {
      expect(code).toMatch(/^arc(\.[a-z]+(_[a-z]+)*)+$/);
    }
  });

  it('reason codes are UPPER_SNAKE and keyed by their own value', () => {
    for (const [key, code] of Object.entries(ARC_REASON_CODES)) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
      expect(code).toBe(key);
    }
  });

  it('every code statusToErrorCode derives is catalogued', () => {
    const values = new Set<string>(Object.values(ERROR_CODES));
    for (let status = 400; status < 600; status++) {
      expect(values.has(statusToErrorCode(status))).toBe(true);
    }
  });

  it('the duplicate-key detail code is the one toErrorContract emits', () => {
    expect(DUPLICATE_KEY_DETAIL_CODE).toBe('duplicate_key');
  });
});
