/**
 * `mergeKeysetPages`: one keyset page over SEVERAL sources, each already ordered by the same total
 * order, merged by the sort key with source order as the final tiebreaker. Each call reads at most
 * one page of `limit` rows per source. ONE composite cursor carries every source's position (the
 * merge frontier) plus a fingerprint of (source names, source scopes, sort); it is HMAC-signed when a
 * secret is given. A cursor that does not decode or verify is `repo.cursor.invalid`; one minted
 * for other sources, another scope or another sort is `repo.cursor.scope_mismatch` (both 400).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CURSOR_ERROR_CODES } from '../errors/codes.js';
import { createError } from '../errors/create-error.js';
import type { HttpError } from '../errors/types.js';

export interface KeysetSource<T> {
  /** Unique among the merged sources; part of the cursor binding. */
  readonly name: string;
  /** What the source's position is relative to (tenant + filter); a change refuses old cursors. */
  readonly scope?: string;
  /** Rows strictly after `after` (this source's own cursor), in the shared order. */
  page(args: { after?: string; limit: number }): Promise<{ data: readonly T[]; hasMore: boolean }>;
  /**
   * This source's cursor positioned AT `row` (its next page starts after it). `row` may come from
   * ANOTHER source (the merge frontier), so every source shares the sort fields, and the final
   * tiebreaker is unique across sources (e.g. an ObjectId).
   */
  cursorOf(row: T): string | Promise<string>;
}

export interface MergeKeysetOptions<T> {
  /** The shared order, ending in a unique tiebreaker (e.g. `{ createdAt: -1, _id: -1 }`). */
  sort: Readonly<Record<string, 1 | -1>>;
  limit: number;
  cursor?: string;
  /** Sign the composite cursor; when set, an unsigned or mis-signed cursor is refused. */
  secret?: string;
  /** Sort-key reader for a row field (default: dotted-path property read). */
  read?: (row: T, field: string) => unknown;
}

export interface MergedKeysetPage<T> {
  docs: Array<{ source: string; row: T }>;
  next: string | null;
  hasNext: boolean;
}

interface Payload {
  v: 1;
  fp: string;
  p: Array<string | null>;
  d: boolean[];
}

function fingerprint(
  sources: readonly KeysetSource<unknown>[],
  sort: Readonly<Record<string, 1 | -1>>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([sources.map((s) => [s.name, s.scope ?? null]), Object.entries(sort)]))
    .digest('hex')
    .slice(0, 16);
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** A 400 carrying a closed code. */
function cursorError(message: string, code: string): HttpError {
  return Object.assign(createError(400, message), { code });
}

const invalid = (why: string) => cursorError(`Invalid cursor: ${why}`, CURSOR_ERROR_CODES.INVALID);

function encode(payload: Payload, secret: string | undefined): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return secret ? `${body}.${sign(body, secret)}` : body;
}

function decode(token: string, secret: string | undefined): Payload {
  const [body, mac, extra] = token.split('.');
  if (!body || extra !== undefined) throw invalid('malformed');
  if (secret) {
    if (!mac) throw invalid('it carries no signature');
    const want = Buffer.from(sign(body, secret));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got))
      throw invalid('signature does not verify');
  } else if (mac !== undefined) {
    throw invalid('signed cursor, but no secret is configured');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalid('not a cursor token');
  }
  const p = payload as Partial<Payload> | null;
  if (
    !p ||
    p.v !== 1 ||
    typeof p.fp !== 'string' ||
    !Array.isArray(p.p) ||
    !Array.isArray(p.d) ||
    p.p.length !== p.d.length ||
    !p.p.every((x) => x === null || typeof x === 'string') ||
    !p.d.every((x) => typeof x === 'boolean')
  ) {
    throw invalid('malformed payload');
  }
  return p as Payload;
}

function readPath(row: unknown, field: string): unknown {
  let cur: unknown = row;
  for (const seg of field.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** BSON-like order for sort values: null / missing first, then numbers, strings, dates, ids. */
function rank(v: unknown): [number, number | string] {
  if (v === null || v === undefined) return [0, 0];
  if (typeof v === 'number') return [1, v];
  if (typeof v === 'bigint') return [1, Number(v)];
  if (typeof v === 'string') return [2, v];
  if (v instanceof Date) return [4, v.getTime()];
  if (typeof v === 'boolean') return [3, v ? 1 : 0];
  if (typeof v === 'object') {
    const bsontype = (v as { _bsontype?: string })._bsontype;
    if (bsontype === 'Decimal128') return [1, Number(String(v))];
    const hex = (v as { toHexString?: () => string }).toHexString;
    if (typeof hex === 'function') return [5, hex.call(v)];
  }
  return [6, String(v)];
}

function compareValues(a: unknown, b: unknown): number {
  const [ta, va] = rank(a);
  const [tb, vb] = rank(b);
  if (ta !== tb) return ta - tb;
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export async function mergeKeysetPages<T>(
  sources: readonly KeysetSource<T>[],
  options: MergeKeysetOptions<T>,
): Promise<MergedKeysetPage<T>> {
  const { sort, limit, secret } = options;
  if (!Number.isInteger(limit) || limit < 1)
    throw new TypeError(`mergeKeysetPages: limit must be a positive integer, got ${limit}`);
  if (new Set(sources.map((s) => s.name)).size !== sources.length) {
    throw new TypeError('mergeKeysetPages: source names must be unique');
  }
  if (Object.keys(sort).length === 0)
    throw new TypeError('mergeKeysetPages: sort must name at least one field');
  const read = options.read ?? readPath;
  const fp = fingerprint(sources, sort);

  let positions: Array<string | null> = sources.map(() => null);
  let done: boolean[] = sources.map(() => false);
  if (options.cursor) {
    const p = decode(options.cursor, secret);
    if (p.fp !== fp || p.p.length !== sources.length) {
      throw cursorError(
        'Invalid cursor: it was issued for different sources, scopes or sort',
        CURSOR_ERROR_CODES.SCOPE_MISMATCH,
      );
    }
    positions = p.p;
    done = p.d;
  }

  const pages = await Promise.all(
    sources.map((s, i) =>
      done[i]
        ? { data: [], hasMore: false }
        : s.page({ ...(positions[i] ? { after: positions[i] as string } : {}), limit }),
    ),
  );
  const fields = Object.entries(sort);
  const cmp = (a: T, b: T): number => {
    for (const [field, dir] of fields) {
      const c = compareValues(read(a, field), read(b, field));
      if (c !== 0) return c * dir;
    }
    return 0;
  };

  const heads = pages.map(() => 0);
  const docs: Array<{ source: string; row: T }> = [];
  while (docs.length < limit) {
    let best = -1;
    for (let i = 0; i < sources.length; i++) {
      const row = pages[i]?.data[heads[i] as number];
      if (row === undefined) continue;
      // Strictly smaller wins; on a full tie the earlier source wins (stable across pages).
      if (best === -1 || cmp(row, pages[best]?.data[heads[best] as number] as T) < 0) best = i;
    }
    if (best === -1) break;
    const row = pages[best]?.data[heads[best] as number] as T;
    docs.push({ source: sources[best]?.name as string, row });
    heads[best] = (heads[best] as number) + 1;
  }

  // Every source resumes from the GLOBAL frontier (the last emitted row), not only from its own
  // last row: otherwise a row inserted into a source that emitted nothing, behind the frontier,
  // would surface later out of order. So the merge pages like one keyset walk over the union.
  const frontier = docs[docs.length - 1]?.row;
  const nextPositions =
    frontier === undefined
      ? positions
      : await Promise.all(sources.map((s) => s.cursorOf(frontier)));
  // A source is done once it returned everything it had and every row was consumed.
  const nextDone = sources.map(
    (_, i) =>
      done[i] === true || (pages[i]?.hasMore === false && heads[i] === pages[i]?.data.length),
  );
  const hasNext = nextDone.some((d) => !d);
  return {
    docs,
    hasNext,
    next: hasNext ? encode({ v: 1, fp, p: nextPositions, d: nextDone }, secret) : null,
  };
}
