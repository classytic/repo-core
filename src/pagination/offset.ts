/**
 * Offset (page-based) pagination helpers.
 *
 * Pure math + validation. Driver-agnostic — kits use the sanitized
 * outputs to compose whatever skip/limit or OFFSET/LIMIT their driver
 * expects.
 */

import type { PaginationConfig } from './types.js';

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_MAX_PAGE = 10_000;

/**
 * Parse, clamp, and sanitize a `limit` value. Accepts string or number
 * input (URL params arrive as strings). Returns the configured default
 * when input is not a finite positive number.
 *
 * `config.maxLimit === 0` disables the upper cap (advanced usage only —
 * unbounded page size is a footgun).
 */
export function validateLimit(limit: number | string, config: PaginationConfig): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return config.defaultLimit ?? DEFAULT_LIMIT;
  }
  const max = config.maxLimit ?? DEFAULT_MAX_LIMIT;
  if (max === 0) return Math.floor(parsed);
  return Math.min(Math.floor(parsed), max);
}

/**
 * Parse, clamp, and sanitize a 1-indexed `page` value.
 * Throws when page exceeds `config.maxPage` — deep offset pagination is
 * pathological and should be caught at the boundary.
 */
export function validatePage(page: number | string, config: PaginationConfig): number {
  const parsed = Number(page);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  const sanitized = Math.floor(parsed);
  const maxPage = config.maxPage ?? DEFAULT_MAX_PAGE;
  if (sanitized > maxPage) {
    throw new Error(`Page ${String(sanitized)} exceeds maximum ${String(maxPage)}`);
  }
  return sanitized;
}

/** True when `page` is past the deep-pagination warning threshold. */
export function shouldWarnDeepPagination(page: number, threshold: number): boolean {
  return page > threshold;
}

/** Documents to skip for a given 1-indexed page + limit. */
export function calculateSkip(page: number, limit: number): number {
  return (page - 1) * limit;
}

/** Total page count from total rows + per-page limit. Zero-safe. */
export function calculateTotalPages(total: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.ceil(total / limit);
}
