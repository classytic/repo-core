/**
 * Repository context — the mutable data bag threaded through every
 * lifecycle hook. Plugins read and mutate it; kits pick up the final
 * shape and translate it to native queries.
 *
 * Convention is intentional: fields carry dominant names even when a
 * particular op doesn't use all of them.
 *
 *   - `query`   — raw filter record or Filter IR. Present on almost every read/write.
 *   - `filters` — paginated-list filters (the `getAll({ filters: … })` shape).
 *   - `data`    — single-doc create/update payload.
 *   - `dataArray` — multi-doc create payload.
 *   - `id`      — primary key, when the op carries one (getById/update/delete).
 *
 * Plugins also write free-form keys for cross-plugin coordination
 * (`softDeleted`, `_cacheHit`, `_cachedResult`, ...). The index signature
 * accepts them without making the shape fully untyped — known fields still
 * narrow correctly.
 */

import type { Filter } from '../filter/index.js';

/** The canonical lifecycle-hook context. */
export interface RepositoryContext {
  /** Operation name (`'create'`, `'getAll'`, `'update'`, ...). */
  operation: string;
  /** Repository / model identifier. Set by `RepositoryBase` from its constructor. */
  model: string;
  /** Primary key for id-bearing ops. */
  id?: string | number | unknown;
  /** Raw filter — Filter IR or plain record. Used by most read/write ops. */
  query?: Filter | Record<string, unknown>;
  /** Paginated-list filter sub-bag (distinct from `query` — see docstring). */
  filters?: Filter | Record<string, unknown>;
  /** Single-doc create/update payload. */
  data?: Record<string, unknown>;
  /** Multi-doc create payload. */
  dataArray?: Record<string, unknown>[];
  /** Arbitrary plugin-owned fields (cache markers, soft-delete flags, ...). */
  [key: string]: unknown;
}
