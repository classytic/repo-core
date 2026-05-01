/**
 * HTTP-shaped error contracts used across every driver kit, integrator,
 * and HTTP-emitting service in the org.
 *
 * **`@classytic/repo-core/errors` is the canonical home for the wire +
 * throwable error contract.** Two complementary shapes live here:
 *
 *   - {@link HttpError} — the *throwable* shape. Plain `Error` with
 *     `status` and optional structured fields. Kits classify their
 *     driver-specific errors into this shape at the boundary; framework
 *     layers (arc) catch and serialize.
 *   - {@link ErrorContract} — the *wire* shape (RFC 7807 / Stripe-style).
 *     What gets serialized into JSON responses, queue dead-letter records,
 *     audit logs, and inter-service error envelopes.
 *
 * Throwable classes (arc's `ArcError` family, future `BillingError` etc.)
 * `implements HttpError` and serialize to `ErrorContract` for the wire.
 * One contract, one canonical home, every package follows the same shape.
 *
 * **Custom-domain escape hatch.** {@link ErrorCode} is a documented union
 * of canonical codes; `code: string` accepts ANY string so domain packages
 * can extend (`'order.validation.missing_line'`, `'payment.gateway.timeout'`).
 * The canonical codes cover cross-cutting concerns; domain extensions
 * hierarchically narrow.
 */

// ============================================================================
// Throwable contract — what kits and integrators throw
// ============================================================================

/** Structured metadata for duplicate-key (unique-constraint) errors. */
export interface DuplicateKeyMeta {
  /** Offending field names. Always safe to log. */
  fields: string[];
  /**
   * Offending values. ONLY populated when the kit's duplicate-key parser
   * was explicitly called with `{ exposeValues: true }`. Values may contain
   * PII (emails, tokens, phone numbers) — never log unconditionally.
   */
  values?: Record<string, unknown>;
}

/** Structured metadata for validation errors. */
export interface ValidationErrorMeta {
  validator: string;
  error: string;
}

/**
 * HTTP-shaped error — the throwable envelope every repository error and
 * arc handler resolves to.
 *
 * Note: `code` and `meta` are optional but every long-lived production
 * handler should populate them. `code` lets clients switch on
 * machine-readable identifiers without grepping `message`; `meta` carries
 * structured diagnostics safe for logs.
 */
export interface HttpError extends Error {
  /** HTTP status code (400, 404, 409, 500, ...). */
  status: number;
  /**
   * Stable machine-readable error code. Use one of {@link ErrorCode} for
   * cross-cutting cases or extend hierarchically with a domain prefix
   * (`'order.validation.missing_line'`, `'payment.gateway.timeout'`).
   * Hosts switch on this in catch blocks instead of regex-matching
   * `message`.
   */
  code?: string;
  /**
   * Free-form structured metadata for diagnostics. Pairs with `code` so
   * hosts can render a clearer message in their own UI without parsing
   * `message`. Safe for logs (don't include PII).
   */
  meta?: Record<string, unknown>;
  /** Structured validation failures when `status` is 400. */
  validationErrors?: ValidationErrorMeta[];
  /** Structured duplicate-key metadata when `status` is 409. */
  duplicate?: DuplicateKeyMeta;
}

// ============================================================================
// Wire contract — what gets serialized to JSON responses, DLQ, audit
// ============================================================================

/**
 * Standard error contract — a framework-agnostic JSON shape that maps
 * cleanly to HTTP responses, worker failure logs, and inter-service
 * errors. Loosely matches RFC 7807 (`application/problem+json`); shape
 * matches Stripe / Shopify / Slack API conventions.
 *
 * Packages throw `HttpError` instances. Hosts (HTTP adapters, workers)
 * serialize those errors into this shape on the wire via
 * {@link toErrorContract}. Wire shape is FLAT (top-level `code` /
 * `message` / `status`), not nested under `{ error: { ... } }` — matches
 * the existing org-wide envelope convention. Hosts that need a
 * Stripe-style nested envelope wrap once at the edge.
 */
export interface ErrorContract {
  /** Machine-readable, hierarchical code — e.g. `'order.validation.missing_line'`. */
  code: string;
  /** Human-readable, safe-for-client message. */
  message: string;
  /** Suggested HTTP status code — hosts may override. */
  status?: number;
  /**
   * Field-scoped structured details. Populated for validation failures
   * (one entry per offending field) or domain errors that map to multiple
   * sub-codes. Distinct from `HttpError.validationErrors` (which is a
   * mongokit-shaped throwable field) — the wire form is canonical.
   */
  details?: readonly ErrorDetail[];
  /** Correlation / trace identifier for support lookups. */
  correlationId?: string;
  /** Non-PII metadata (safe to log, safe to return to clients). */
  meta?: Readonly<Record<string, unknown>>;
}

/** A single field-scoped error detail. */
export interface ErrorDetail {
  /** Dot-path pointer to the offending field, e.g. `'lines.0.quantity'`. */
  path?: string;
  code: string;
  message: string;
  meta?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Canonical codes
// ============================================================================

/**
 * Cross-cutting error codes used across the org. Every canonical code is
 * lowercase + snake_case to match RFC 7807, Stripe, and Shopify
 * conventions. Domain packages add their own hierarchical codes
 * (`'order.validation.*'`, `'payment.gateway.*'`); these cover the
 * universal cases every HTTP-emitting layer needs.
 *
 * **Arc compatibility note.** Arc's `ArcError` hierarchy historically
 * uses UPPER_SNAKE codes (`'NOT_FOUND'`, `'VALIDATION_ERROR'`) for
 * back-compat with hosts that switch on those values. New code should
 * prefer the canonical lowercase codes; arc keeps emitting its UPPER_SNAKE
 * codes on the wire so existing client switches keep working.
 */
export const ERROR_CODES = {
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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
