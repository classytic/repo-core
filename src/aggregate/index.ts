/**
 * Portable aggregate IR helpers — the kit-neutral half of the
 * aggregate compilation pipeline.
 *
 * Every kit (mongokit, sqlitekit, future pgkit) consumes these. The
 * driver-specific compilers (`$group` builders for Mongo, Drizzle SQL
 * builders for SQLite) stay in each kit; everything in this barrel is
 * pure logic that operates on the IR types in `repo-core/repository`.
 */

export {
  type DecodedCursor,
  decodeAggCursor,
  encodeAggCursor,
  isKeysetMode,
} from './keyset.js';
export { normalizeGroupBy, validateMeasures } from './normalize.js';
