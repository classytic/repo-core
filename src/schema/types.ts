/**
 * Schema contract types — shared across every kit that emits JSON Schemas
 * from its native schema (Mongoose models, Drizzle tables, Prisma schemas,
 * zod schemas, etc.).
 *
 * Driver-free by design: every field on every type describes the *output*
 * shape, not how it's produced. A kit's introspection code (mongooseToJsonSchema,
 * drizzleToJsonSchema, ...) fills in the shape; repo-core just locks the
 * contract so switching kits is a package swap, not an API rewrite.
 */

/**
 * Per-field rule — declarative constraints that shape how a field appears
 * in the create / update / query body schemas.
 *
 * These are pure policy: they touch neither the DB schema nor the Filter IR.
 * A kit's schema builder reads them and omits / optionalizes fields in the
 * generated JSON Schema accordingly.
 */
export interface FieldRule {
  /** Field cannot be updated — omitted from the update body schema. */
  immutable?: boolean;
  /** Alias for `immutable`. Kept for docstring clarity at call sites. */
  immutableAfterCreate?: boolean;
  /** System-only field — omitted from both create AND update body schemas. */
  systemManaged?: boolean;
  /** Remove from `required[]` in the generated schema. DB-level constraints unaffected. */
  optional?: boolean;
  /**
   * Strip the field from the response shape. Use for passwords, secrets,
   * internal scoring — anything the server stores but should never echo.
   *
   * Distinct from `systemManaged` (which only affects request bodies):
   * `hidden` is a *response* concern and lives at the schema-builder
   * boundary so kits, OpenAPI tooling, and arc's response serializer
   * narrow on the same flag.
   */
  hidden?: boolean;
}

/** Map of field name → FieldRule. */
export interface FieldRules {
  [fieldName: string]: FieldRule;
}

/**
 * JSON Schema (draft-07 subset) — intentionally loose so kits can emit
 * vendor extensions (`x-ref`, `x-foreign-key`, etc.) without type pressure.
 */
export interface JsonSchema {
  type: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | unknown;
  items?: unknown;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minProperties?: number;
  maxProperties?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
  title?: string;
  [key: `x-${string}`]: unknown;
}

/**
 * CRUD schema bundle — the JSON Schemas every HTTP endpoint needs:
 * body validation on POST / PATCH, route-param validation on id routes,
 * query-string validation on list endpoints, and (optionally) response-shape
 * documentation for OpenAPI / strict reply serialization.
 */
export interface CrudSchemas {
  /** JSON Schema for create request body (POST). */
  createBody: JsonSchema;
  /** JSON Schema for update request body (PATCH / PUT). */
  updateBody: JsonSchema;
  /** JSON Schema for route params (id validation). */
  params: JsonSchema;
  /** JSON Schema for list/query parameters. */
  listQuery: JsonSchema;
  /**
   * JSON Schema for response shape (optional).
   *
   * Includes every field a client receives — server-set fields
   * (`createdAt`, `updatedAt`, `_id`, immutable / readonly fields) ARE
   * returned to clients and so ARE included in the response shape, in
   * contrast to `createBody` / `updateBody` which exclude them. Only
   * `fieldRules[field].hidden: true` excludes a field from responses
   * (passwords, secrets, internal scoring).
   *
   * Set `additionalProperties: true` so virtuals and computed fields
   * pass through without being stripped by AJV's strict serialization.
   *
   * Optional — kits that don't ship a response builder leave it unset
   * and arc treats response validation as opt-out for that resource.
   */
  response?: JsonSchema;
}

/**
 * Options consumed by every kit's schema builder. Fields are additive:
 * kit-specific extensions live on a separate extending interface so the
 * portable subset stays identical across kits.
 */
export interface SchemaBuilderOptions {
  /** Field rules for create/update schemas. */
  fieldRules?: FieldRules;
  /**
   * Global field exclusion — fields listed here are dropped from EVERY
   * generated schema (create / update / response). Shortcut for setting
   * `create.omitFields`, `update.omitFields`, AND `response.omitFields`
   * to the same list. Use for fields that should never appear in any
   * HTTP-facing schema (e.g. internal-only columns, framework-private
   * fields).
   *
   * Per-purpose overrides still apply on top — a field listed here AND
   * in `create.omitFields` is dropped once.
   */
  excludeFields?: string[];
  /**
   * When `true`, emit `"additionalProperties": false` on create/update/query
   * schemas. Default `false` so generators stay permissive by default;
   * Fastify/AJV consumers typically flip this on for stricter validation.
   */
  strictAdditionalProperties?: boolean;
  /** Date rendering: `'datetime'` → `format: date-time`; `'date'` → `format: date`. */
  dateAs?: 'date' | 'datetime';

  /** Create-schema overrides. */
  create?: {
    /** Fields to omit from the create body. */
    omitFields?: string[];
    /** Force field to required (merged with auto-detected required). */
    requiredOverrides?: Record<string, boolean>;
    /** Force field to optional (even if DB-level required). */
    optionalOverrides?: Record<string, boolean>;
    /** Replace the generated schema for a specific field. */
    schemaOverrides?: Record<string, unknown>;
  };

  /**
   * Field names to mark as soft-required: they remain in the generated body
   * schema's `properties` (still validated when present) but are excluded
   * from the `required[]` array so the client may omit them.
   *
   * DB-level `required: true` invariants are unaffected — the driver still
   * rejects null on save. This flag only affects HTTP body validation.
   */
  softRequiredFields?: string[];

  /** Update-schema overrides. */
  update?: {
    /** Fields to omit from the update body. */
    omitFields?: string[];
    /** When `true`, reject empty update bodies (`minProperties: 1`). */
    requireAtLeastOne?: boolean;
  };

  /** List-query schema overrides. */
  query?: {
    /** Extra filterable fields exposed on the list-query schema. */
    filterableFields?: Record<string, { type: string } | unknown>;
  };

  /**
   * Response-schema overrides.
   *
   * Response shape includes server-set fields (`createdAt`, `updatedAt`,
   * `_id`, immutable / readonly / systemManaged fields) since those ARE
   * returned to clients. Only `fieldRules[field].hidden: true` fields are
   * stripped automatically. Use `omitFields` to drop additional fields
   * from responses without marking them globally hidden (e.g. internal
   * scoring you want kept in update bodies but stripped from list reads).
   */
  response?: {
    /** Extra fields to omit from the response shape. */
    omitFields?: string[];
  };

  /**
   * Emit OpenAPI vendor extensions (`x-*` keywords like `x-ref` for populated
   * foreign-key fields).
   *
   * Default `false` because Ajv strict mode throws on unknown `x-*` keywords.
   * Turn ON when feeding the schema into a docgen tool (Swagger, Redocly).
   */
  openApiExtensions?: boolean;
}

/**
 * Result of `validateUpdateBody` — caller-friendly shape with structured
 * violations for each disallowed field.
 */
export interface ValidationResult {
  valid: boolean;
  violations?: Array<{
    field: string;
    reason: string;
  }>;
  message?: string;
}
