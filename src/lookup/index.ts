/**
 * Public entry for the `lookup` subpath.
 *
 * Types-only surface — the Filter IR / AggRequest pattern. Each kit
 * implements `StandardRepo.lookupPopulate` against these types so
 * cross-kit lookup code stays portable without any runtime from
 * repo-core.
 */

export type {
  LookupPopulateOptions,
  LookupPopulateResult,
  LookupRow,
  LookupSpec,
} from './types.js';
