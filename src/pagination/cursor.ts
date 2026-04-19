/**
 * Cursor codec — driver-agnostic, browser-safe, URL-safe base64.
 *
 * The cursor is a base64url-encoded JSON payload carrying the sort value(s)
 * and id of the last row on a page. Encoding/decoding is pure and
 * algorithmic — it knows nothing about MongoDB, Postgres, or Prisma.
 *
 * The translation from "decoded cursor" → "driver-native keyset filter"
 * (Mongo `$gt`/`$lt`, SQL `WHERE (a, b) > (?, ?)`, Prisma cursor args)
 * lives in each kit's own compiler, not here.
 */

import type { CursorPayload, DecodedCursor, SortSpec, ValueType } from './types.js';

/** Core value types repo-core knows how to round-trip natively. */
const CORE_TYPES: readonly ValueType[] = ['date', 'boolean', 'number', 'string', 'null', 'unknown'];

/**
 * Encode a document's sort values and id into a base64url cursor token.
 *
 * The encoder accepts arbitrary string type tags beyond the core set; a kit
 * that wants to tag an id as `'objectid'` can stamp that in the payload and
 * decode it back on its side. Repo-core doesn't narrow unknown tags; they
 * round-trip as `string` values.
 *
 * @param doc           — document to extract cursor values from
 * @param primaryField  — primary sort field name (non-_id preferred, `_id` fallback)
 * @param sort          — normalized sort specification the cursor describes
 * @param version       — cursor format version; bump on breaking format changes
 * @param tagValue      — optional override for type tagging (kit extension point).
 *                        When omitted, repo-core uses a minimal tagger that emits
 *                        `date | boolean | number | string | null | unknown`.
 */
export function encodeCursor(
  doc: Record<string, unknown>,
  primaryField: string,
  sort: SortSpec,
  version = 1,
  tagValue: (value: unknown) => string = defaultTagValue,
): string {
  const primaryValue = doc[primaryField];
  const idValue = doc['_id'] ?? doc['id'];

  const sortFields = Object.keys(sort).filter((k) => k !== '_id');
  const vals: Record<string, string | number | boolean | null> = {};
  const types: Record<string, string> = {};
  for (const field of sortFields) {
    vals[field] = serializeValue(doc[field]);
    types[field] = tagValue(doc[field]);
  }

  const payload: CursorPayload = {
    v: serializeValue(primaryValue),
    t: tagValue(primaryValue),
    id: String(serializeValue(idValue) ?? ''),
    idType: tagValue(idValue),
    sort,
    ver: version,
    ...(sortFields.length > 1 && { vals, types }),
  };

  return base64urlEncode(JSON.stringify(payload));
}

/**
 * Decode a cursor token back into a structured payload.
 *
 * Accepts both URL-safe (`-`/`_`) and standard (`+`/`/`) base64 alphabets,
 * so cursors emitted by mongokit ≤3.x (which used Node `Buffer` standard
 * base64) remain decodable after a kit upgrade.
 *
 * Unknown type tags round-trip as strings — kits that need typed
 * rehydration (`'objectid'` → `ObjectId` instance) can post-process the
 * decoded cursor on their side.
 */
export function decodeCursor(token: string): DecodedCursor {
  let json: string;
  try {
    json = base64urlDecode(token);
  } catch {
    throw new Error('Invalid cursor token: not valid base64');
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(json) as CursorPayload;
  } catch {
    throw new Error('Invalid cursor token: not valid JSON');
  }

  if (!isValidPayload(payload)) {
    throw new Error('Invalid cursor token: malformed payload structure');
  }

  let values: Record<string, unknown> | undefined;
  if (payload.vals && payload.types) {
    values = {};
    for (const [field, serialized] of Object.entries(payload.vals)) {
      values[field] = rehydrateValue(serialized, payload.types[field] ?? 'unknown');
    }
  }

  return {
    value: rehydrateValue(payload.v, payload.t),
    id: rehydrateValue(payload.id, payload.idType),
    sort: payload.sort,
    version: payload.ver,
    ...(values && { values }),
  };
}

/** Throw when the cursor's sort doesn't match the current query sort. */
export function validateCursorSort(cursorSort: SortSpec, currentSort: SortSpec): void {
  if (JSON.stringify(cursorSort) !== JSON.stringify(currentSort)) {
    throw new Error('Cursor sort does not match current query sort');
  }
}

/**
 * Validate cursor version against the server's accepted range.
 *
 * - Cursors newer than `expectedVersion` → client is ahead of server; reject.
 * - Cursors older than `minVersion` → client cached a cursor from a
 *   pre-breaking-change deploy; reject so pagination restarts cleanly.
 */
export function validateCursorVersion(
  cursorVersion: number,
  expectedVersion: number,
  minVersion = 1,
): void {
  if (cursorVersion > expectedVersion) {
    throw new Error(
      `Cursor version ${String(cursorVersion)} is newer than expected version ${String(expectedVersion)}. Please upgrade.`,
    );
  }
  if (cursorVersion < minVersion) {
    throw new Error(
      `Cursor version ${String(cursorVersion)} is older than minimum supported ${String(minVersion)}. Pagination must restart.`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function isValidPayload(payload: unknown): payload is CursorPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    'v' in p &&
    typeof p['t'] === 'string' &&
    typeof p['id'] === 'string' &&
    typeof p['idType'] === 'string' &&
    typeof p['sort'] === 'object' &&
    p['sort'] !== null &&
    typeof p['ver'] === 'number'
  );
}

function serializeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // Kits may hand us driver types (ObjectId, UUID wrappers) that have a
  // meaningful `toString`. Fall back to that so the cursor stays opaque
  // without repo-core needing to know the driver type.
  return String(value);
}

function defaultTagValue(value: unknown): ValueType {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

function rehydrateValue(serialized: unknown, tag: string): unknown {
  if (tag === 'null' || serialized === null) return null;
  if (!CORE_TYPES.includes(tag as ValueType)) {
    // Kit-owned type tag — return the serialized form as-is; kits that need
    // a typed instance do their own conversion after decoding.
    return serialized;
  }
  switch (tag as ValueType) {
    case 'date':
      return new Date(serialized as string);
    case 'boolean':
      return serialized === true || serialized === 'true';
    case 'number':
      return Number(serialized);
    case 'string':
      return String(serialized);
    default:
      return serialized;
  }
}

// URL-safe base64 (RFC 4648 §5) with standard-base64 decode compatibility.
// Uses globalThis.btoa/atob so the codec works in Node 22+ and every browser.

function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(token: string): string {
  // Accept both URL-safe and standard dialects so legacy cursors decode.
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLen);
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
