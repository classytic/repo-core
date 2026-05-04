/**
 * Canonical JSON Schema constants for `ErrorContract` + `ErrorDetail`.
 *
 * The runtime wire spec for the `ErrorContract` and `ErrorDetail`
 * TypeScript interfaces in `./types.ts`. Lives next to the interface so
 * downstream packages (arc, every kit, host apps) consume from one place
 * and the JSON Schema cannot drift away from the TS shape.
 *
 * Plain JSON-Schema objects — no runtime dependency on AJV, TypeBox,
 * Zod, or any validator. Anything that consumes JSON Schema can use
 * these (Fastify schema validator, OpenAPI generators, AJV directly,
 * `Type.Unsafe<ErrorContract>(errorContractSchema)` for TypeBox).
 */

/**
 * Single field-scoped error detail. Mirrors `ErrorDetail` in
 * {@link ./types.ts}.
 */
export const errorDetailSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: "Dot-path to the offending field, e.g. 'lines.0.quantity'.",
    },
    code: { type: 'string' },
    message: { type: 'string' },
    meta: {
      type: 'object',
      description: 'Non-PII per-detail diagnostics (safe to log + return).',
    },
  },
  required: ['code', 'message'],
} as const;

/**
 * Canonical error response. Mirrors `ErrorContract` in {@link ./types.ts}.
 *
 * `code` and `message` are the only required fields. `status` is a
 * *suggested* HTTP status hosts may override at the edge. `details` is
 * an array of structured `ErrorDetail` objects (validation failures,
 * duplicate-key surfaces, etc.). `meta` is a non-PII object.
 *
 * Wire shape every 4xx/5xx response in the org follows. Errors live on
 * a separate path from success — HTTP status discriminates.
 */
export const errorContractSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: "Hierarchical machine-readable code (e.g. 'arc.not_found').",
    },
    message: { type: 'string', description: 'Human-readable, safe-for-client message.' },
    status: {
      type: 'integer',
      description: 'Suggested HTTP status code (hosts may override).',
    },
    details: {
      type: 'array',
      description:
        'Field-scoped structured details (validation failures, duplicate keys, multi-code domain errors).',
      items: errorDetailSchema,
    },
    correlationId: { type: 'string', description: 'Request id for support lookups.' },
    meta: { type: 'object', description: 'Non-PII diagnostics (safe to log + return).' },
  },
  required: ['code', 'message'],
} as const;
