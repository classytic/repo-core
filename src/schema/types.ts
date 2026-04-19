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
 * CRUD schema bundle — the four JSON Schemas every HTTP endpoint needs:
 * body validation on POST / PATCH, route-param validation on id routes, and
 * query-string validation on list endpoints.
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
