/**
 * `before` and `mode` are control params (never filters), and `readPageRequest` returns them:
 * `before` is a keyset cursor like `after` (both at once is refused), `mode` is `offset` | `keyset`
 * (anything else is refused, never ignored).
 */

import { describe, expect, it } from 'vitest';
import {
  isControlParam,
  QueryGrammarError,
  readPageRequest,
  STANDARD_RESERVED_PARAMS,
} from '../../../src/query-parser/index.js';

describe('keyset page params', () => {
  it('reserves before and mode beside after', () => {
    for (const p of ['after', 'before', 'mode']) {
      expect(STANDARD_RESERVED_PARAMS.has(p), p).toBe(true);
      expect(isControlParam(p), p).toBe(true);
    }
  });

  it('returns before, and refuses before together with after', () => {
    expect(readPageRequest({ before: 'tok', limit: 5 })).toEqual({ limit: 5, before: 'tok' });
    expect(() => readPageRequest({ before: 'a', after: 'b' })).toThrow(QueryGrammarError);
  });

  it('returns a valid mode and refuses any other', () => {
    expect(readPageRequest({ mode: 'keyset' })).toMatchObject({ mode: 'keyset' });
    expect(readPageRequest({ mode: 'offset', page: 2 })).toMatchObject({ mode: 'offset', page: 2 });
    expect(() => readPageRequest({ mode: 'cursor' })).toThrow(QueryGrammarError);
  });
});
