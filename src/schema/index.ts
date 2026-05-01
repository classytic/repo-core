/**
 * Public entry for the `schema` subpath.
 *
 * Ships the portable half of the JSON-Schema generator: the contract types
 * and the pure policy helpers (`fieldRules` → omit/required logic). The
 * driver-specific half — introspecting native schemas (Mongoose paths,
 * Drizzle columns, Prisma models, zod schemas) into JSON Schemas — stays
 * in each kit.
 *
 * Consumer convention:
 *   - Define a single `SchemaBuilderOptions` shape per model.
 *   - Feed it to `buildCrudSchemasFromModel` (mongokit) or
 *     `buildCrudSchemasFromTable` (sqlitekit) — same output `CrudSchemas`
 *     regardless of backend.
 *   - Swapping kits = swap the builder import; HTTP layer stays unchanged.
 */

export {
  applyFieldRules,
  collectFieldsToOmit,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from './field-rules.js';
export type { SchemaGenerator, SchemaGeneratorContext } from './generator.js';
export { isSchemaGenerator } from './generator.js';
export type {
  CrudSchemas,
  FieldRule,
  FieldRules,
  JsonSchema,
  SchemaBuilderOptions,
  ValidationResult,
} from './types.js';
