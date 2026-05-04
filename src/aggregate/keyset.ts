/**
 * Keyset (cursor) pagination helpers — the portable, kit-neutral half.
 *
 * Cursor encode/decode is identical across kits: serialize the sort-key
 * tuple of the last row, base64url it, hand back. Every kit's
 * `aggregatePaginate(req)` produced byte-identical encodings before
 * this module landed — the duplication served no purpose.
 *
 * What this module does NOT cover: building the kit-specific predicate
 * that selects rows AFTER the cursor. Mongo emits a `$match` JSON
 * stage; SQL emits a `HAVING (col1, col2) > (?, ?)` Drizzle SQL
 * fragment. Those compilers stay in each kit because they speak the
 * driver's query language. They consume `DecodedCursor` from here.
 *
 * **Cross-kit cursor compatibility is not promised.** The encoded
 * cursor depends on which keys the kit's sort spec ends up using — a
 * Mongo cursor with `_id` won't round-trip on a SQL kit using `id`.
 * Consumers MUST round-trip cursors verbatim against the same backend
 * that produced them.
 */

/**
 * Decoded cursor — sort-key → value tuples from the last row of the
 * prior page. Values are JSON-serialisable scalars (numbers, strings,
 * booleans, ISO date strings). `undefined` and `null` collapse to
 * `null` on encode so the round-trip is stable.
 */
export type DecodedCursor = Record<string, unknown>;

/**
 * Encode a cursor from the last row of a page given the sort spec.
 *
 * Only sort keys are extracted — the cursor MUST be small (it travels
 * over the URL on every "next page" request). Carrying the full row
 * would inflate cursors with measure values and group keys that
 * aren't load-bearing for pagination.
 */
export function encodeAggCursor(
  row: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
): string {
  const tuple: DecodedCursor = {};
  for (const key of Object.keys(sort)) {
    tuple[key] = row[key];
  }
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/**
 * Decode a cursor previously produced by `encodeAggCursor`. Throws on
 * any malformed cursor — callers should treat the throw as "client
 * sent garbage" and surface a 400-class error rather than masking it.
 *
 * The `kitName` prefix on the error message keeps stack-trace context
 * legible (`'mongokit/aggregate: ...'` vs `'sqlitekit/aggregate: ...'`).
 */
export function decodeAggCursor(cursor: string, kitName: string): DecodedCursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(
      `${kitName}/aggregate: malformed keyset cursor — base64url+JSON decode failed (${(cause as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${kitName}/aggregate: malformed keyset cursor — expected an object payload`);
  }
  return parsed as DecodedCursor;
}

/**
 * Pick the keyset mode flag from the request shape. `pagination:
 * 'keyset'` is the explicit form; setting `after` implies keyset
 * (handing back a cursor token in offset mode would be a wiring bug).
 */
export function isKeysetMode(req: { pagination?: string; after?: string }): boolean {
  if (req.pagination === 'keyset') return true;
  if (typeof req.after === 'string' && req.after.length > 0) return true;
  return false;
}
