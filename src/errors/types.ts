/**
 * HTTP-shaped error contract used across every driver kit.
 *
 * An `HttpError` is a plain `Error` with a `status` field and optional
 * structured fields for duplicate-key and validation conflicts. Kits
 * classify their driver-specific errors into this shape at the boundary,
 * so the framework layer (arc) never needs to know whether the error
 * originated from MongoDB `E11000`, Postgres `23505`, or Prisma `P2002`.
 */

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

/** HTTP-shaped error — the envelope every repository error resolves to. */
export interface HttpError extends Error {
  /** HTTP status code (400, 404, 409, 500, ...). */
  status: number;
  /** Structured validation failures when `status` is 400. */
  validationErrors?: ValidationErrorMeta[];
  /** Structured duplicate-key metadata when `status` is 409. */
  duplicate?: DuplicateKeyMeta;
}
