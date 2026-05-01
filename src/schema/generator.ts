/**
 * Canonical schema-generator contract for repository kits.
 *
 * Every kit that produces CRUD JSON schemas (mongokit's
 * `buildCrudSchemasFromModel`, sqlitekit's `buildCrudSchemasFromTable`,
 * future kits' equivalents) implements {@link SchemaGenerator}. Arc's
 * `MongooseAdapter.schemaGenerator` / `DrizzleAdapter.schemaGenerator`
 * fields type the callback as `SchemaGenerator<TKitModel>`, so kits
 * structurally satisfy the contract via `satisfies SchemaGenerator<...>`
 * — no inheritance, no glue, just type-level alignment.
 *
 * **What the generator output gets used for** (load-bearing, not just docs):
 *   1. **Fastify route validation** — arc passes `createBody` / `params` /
 *      `listQuery` / `response` straight into `fastify.route({ schema })`.
 *      AJV rejects invalid payloads at the wire boundary BEFORE the
 *      controller runs.
 *   2. **MCP tool input schemas** — `arc/integrations/mcp/input-schema.ts`
 *      reads the same `createBody` and emits the matching MCP tool schema
 *      (via `fieldRulesToZod`). REST and AI surfaces share one contract.
 *   3. **OpenAPI documentation** — `arc docs ./openapi.json` emits the
 *      full spec from these schemas.
 *
 * Custom controllers do NOT bypass validation: schemas wire into Fastify
 * at the route level, AJV runs before the handler. The only opt-out is
 * `routes: [{ raw: true, ... }]` for webhooks / SSE / file streaming
 * where the handler validates manually.
 */

import type { CrudSchemas, SchemaBuilderOptions } from './types.js';

/**
 * Resource-level context threaded into the generator at boot. Lets the
 * generator shape output to per-resource config (idField pattern,
 * resource name for OpenAPI titles).
 *
 * All fields optional — generators that ignore the context still produce
 * valid schemas; arc applies safety-net normalization downstream.
 */
export interface SchemaGeneratorContext {
  /**
   * The `idField` configured on the resource. Defaults to `'_id'` for
   * Mongoose-shaped kits, `'id'` for SQL kits. Generators emit the
   * matching `params.properties[idField]` so route-param validation
   * matches the actual lookup field.
   */
  idField?: string;
  /** Resource name (for OpenAPI titles, generator log messages). */
  resourceName?: string;
}

/**
 * Canonical generator contract. Functions that produce CRUD JSON schemas
 * for a kit satisfy this shape — `mongokit/buildCrudSchemasFromModel`,
 * `sqlitekit/buildCrudSchemasFromTable`, etc.
 *
 * The return type is intentionally widened to `CrudSchemas | Record<string,
 * unknown>` so kits that emit additional vendor-specific schema fields
 * (`x-ref`, `x-foreign-key`, OpenAPI extensions) flow through without
 * type erosion. Arc's adapter post-processes via `mergeFieldRuleConstraints`
 * so portable `fieldRules` constraints (`minLength`/`maxLength`/`min`/
 * `max`/`pattern`/`enum`/`description`/`nullable`) apply uniformly across
 * kit outputs.
 *
 * @typeParam TModel - The kit's native model / table type. `Model<unknown>`
 *   for Mongoose kits, a Drizzle `Table` for SQL kits, etc. Widened to
 *   `unknown` by default so adapters that don't care about model typing
 *   (or cross-kit utilities) pass any model through.
 *
 * @example mongokit conformance (one-line `satisfies`)
 * ```ts
 * import type { SchemaGenerator } from '@classytic/repo-core/schema';
 *
 * export const buildCrudSchemasFromModel = ((model, options, ctx) => {
 *   // ... existing impl
 * }) satisfies SchemaGenerator<Model<unknown>>;
 * ```
 *
 * @example arc adapter typing
 * ```ts
 * import type { SchemaGenerator } from '@classytic/repo-core/schema';
 *
 * interface MongooseAdapterOptions<TDoc> {
 *   schemaGenerator?: SchemaGenerator<Model<unknown>>;
 * }
 * ```
 */
export type SchemaGenerator<TModel = unknown> = (
  model: TModel,
  options?: SchemaBuilderOptions,
  context?: SchemaGeneratorContext,
) => CrudSchemas | Record<string, unknown>;

/**
 * Runtime predicate — true when `value` matches the generator shape.
 *
 * Conservative: only checks `typeof value === 'function'` and arity.
 * Doesn't invoke the function with a sentinel argument because doing so
 * could trigger expensive schema introspection on a single test call.
 * The structural-typing alignment (`satisfies SchemaGenerator<...>`) is
 * the primary contract enforcement; this guard is for runtime hosts that
 * accept either a generator or a config-bag.
 */
export function isSchemaGenerator(value: unknown): value is SchemaGenerator {
  return typeof value === 'function' && value.length >= 1 && value.length <= 3;
}
