/**
 * The error-code vocabulary of the wire — every value a client may see in
 * `ErrorContract.code`, in one place.
 *
 * Codes live here, in the contract package, rather than in the servers that
 * emit them: a client SDK consumes the wire vocabulary by depending on
 * repo-core, never on the server framework. The emitting side proves it only
 * uses catalogued codes (arc's test suite fails on an uncatalogued `arc.*`
 * literal); the consuming side spreads these constants instead of copying
 * strings, so an addition reaches every client with a repo-core bump.
 *
 * Three families:
 *
 *   - {@link ERROR_CODES} — cross-cutting, lowercase snake_case (RFC 7807 /
 *     Stripe style). What {@link statusToErrorCode} derives and any
 *     HTTP-emitting package may use.
 *   - {@link ARC_ERROR_CODES} — arc's `arc.`-namespaced codes: the
 *     status-derived family, request validation, auth, tenancy, idempotency,
 *     capacity, and per-feature codes. Values are wire-stable — never renamed.
 *   - {@link ARC_REASON_CODES} — UPPER_SNAKE business reasons arc's mixins put
 *     on `code` alongside the HTTP status (why a bulk write was refused, …).
 *
 * `ErrorContract.code` stays `string`: domain packages extend hierarchically
 * (`'order.validation.missing_line'`) without registering here.
 */

// ============================================================================
// Cross-cutting
// ============================================================================

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

// ============================================================================
// arc
// ============================================================================

export const ARC_ERROR_CODES = {
  // Status-derived — what a bare HTTP-status throw serializes to.
  ERROR: 'arc.error',
  BAD_REQUEST: 'arc.bad_request',
  UNAUTHORIZED: 'arc.unauthorized',
  FORBIDDEN: 'arc.forbidden',
  NOT_FOUND: 'arc.not_found',
  CONFLICT: 'arc.conflict',
  PAYLOAD_TOO_LARGE: 'arc.payload_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'arc.unsupported_media_type',
  UNPROCESSABLE_ENTITY: 'arc.unprocessable_entity',
  RATE_LIMITED: 'arc.rate_limited',
  INTERNAL_ERROR: 'arc.internal_error',
  NOT_IMPLEMENTED: 'arc.not_implemented',
  BAD_GATEWAY: 'arc.bad_gateway',
  SERVICE_UNAVAILABLE: 'arc.service_unavailable',
  GATEWAY_TIMEOUT: 'arc.gateway_timeout',

  // Request shape.
  VALIDATION_ERROR: 'arc.validation_error',
  INVALID_ID: 'arc.invalid_id',
  INVALID_ACTION: 'arc.invalid_action',
  UNSUPPORTED_API_VERSION: 'arc.unsupported_api_version',
  /** A stale `If-Match` — re-read the document (its `ETag`) and retry. HTTP 412. */
  PRECONDITION_FAILED: 'arc.precondition_failed',

  // Authentication.
  AUTH_INVALID_TOKEN_TYPE: 'arc.auth.invalid_token_type',
  AUTH_TOKEN_REVOKED: 'arc.auth.token_revoked',
  AUTH_REVOCATION_CHECK_FAILED: 'arc.auth.revocation_check_failed',
  AUTH_MISCONFIGURED: 'arc.auth.misconfigured',
  /** HTTP 500 — the auth provider itself failed (not a bad credential). */
  AUTH_SERVICE_ERROR: 'arc.auth.service_error',
  /** HTTP 401 — `x-arc-scope: platform` without an authenticated user. */
  ELEVATION_AUTH_REQUIRED: 'arc.elevation.auth_required',
  /** HTTP 403 — `x-arc-scope: platform` from a user without a platform role. */
  ELEVATION_FORBIDDEN: 'arc.elevation.forbidden',

  // Tenancy and entitlement.
  ORG_SELECTION_REQUIRED: 'arc.org.selection_required',
  ORG_ACCESS_DENIED: 'arc.org.access_denied',
  /** Convention for host tier gates; arc surfaces it verbatim with `{ requiredMode, currentMode }`. */
  TIER_REQUIRED: 'arc.tier_required',

  // Idempotency.
  /** HTTP 400 — the route requires an `Idempotency-Key`. */
  IDEMPOTENCY_KEY_REQUIRED: 'arc.idempotency_key_required',
  /** HTTP 422 — the key already named an operation with a different body. */
  IDEMPOTENCY_KEY_REUSED: 'arc.idempotency_key_reused',
  /** HTTP 400 — the body could not be fingerprinted (too deep). */
  IDEMPOTENCY_BODY_UNFINGERPRINTABLE: 'arc.idempotency_body_unfingerprintable',
  /** HTTP 409 — the same key is still executing; retry after `Retry-After`. */
  IDEMPOTENCY_CONFLICT: 'arc.idempotency_conflict',

  // Capacity — retry after `Retry-After`.
  CIRCUIT_OPEN: 'arc.circuit_open',
  UNAVAILABLE: 'arc.unavailable',

  /** HTTP 500 — a host write verb broke its contract (e.g. `create` returned nothing). */
  WRITE_VERB_CONTRACT_VIOLATION: 'arc.write_verb.contract_violation',

  // Adapter capability.
  ADAPTER_CAPABILITY_REQUIRED: 'arc.adapter.capability_required',
  NO_ADAPTER: 'arc.no_adapter',

  // Aggregation.
  AGGREGATION_MAX_GROUPS_EXCEEDED: 'arc.aggregation.max_groups_exceeded',
  AGGREGATION_REQUIRED_FILTER_MISSING: 'arc.aggregation.required_filter_missing',
  AGGREGATION_REQUIRED_DATE_RANGE_MISSING: 'arc.aggregation.required_date_range_missing',
  AGGREGATION_DATE_RANGE_EXCEEDED: 'arc.aggregation.date_range_exceeded',

  // Events, realtime, jobs, workflows, purge, MCP.
  EVENT_VALIDATION_ERROR: 'arc.event.validation_error',
  REALTIME_UNFILTERABLE: 'arc.realtime.unfilterable',
  JOBS_POLICY_UNSUPPORTED: 'arc.jobs.policy_unsupported',
  STREAMLINE_INVALID_BODY: 'arc.streamline.invalid_body',
  STREAMLINE_MISSING_INPUT_ENVELOPE: 'arc.streamline.missing_input_envelope',
  STREAMLINE_UNKNOWN_ENVELOPE_KEYS: 'arc.streamline.unknown_envelope_keys',
  PURGE_CHUNKED_REQUIRED: 'arc.purge.chunked_required',
  PURGE_UNSUPPORTED_STRATEGY: 'arc.purge.unsupported_strategy',
  PURGE_NO_BULK_OP: 'arc.purge.no_bulk_op',
  MCP_TOOL_NAME_COLLISION: 'arc.mcp.tool_name_collision',
} as const;

export type ArcErrorCode = (typeof ARC_ERROR_CODES)[keyof typeof ARC_ERROR_CODES];

export const ARC_REASON_CODES = {
  ORG_CONTEXT_REQUIRED: 'ORG_CONTEXT_REQUIRED',
  MIXED_UPDATE_SHAPE: 'MIXED_UPDATE_SHAPE',
  ALL_FIELDS_STRIPPED: 'ALL_FIELDS_STRIPPED',
  BEFORE_RESTORE_HOOK_ERROR: 'BEFORE_RESTORE_HOOK_ERROR',
} as const;

export type ArcReasonCode = (typeof ARC_REASON_CODES)[keyof typeof ARC_REASON_CODES];

/** `details[].code` for a unique-constraint violation (see `toErrorContract`). */
export const DUPLICATE_KEY_DETAIL_CODE = 'duplicate_key';
