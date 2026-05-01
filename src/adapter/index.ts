/**
 * Public entry for the `adapter` subpath.
 *
 * Framework-agnostic data-adapter contract — the shape every kit's
 * `createXxxAdapter()` factory produces, and every host (arc, custom
 * frameworks) consumes. Lets kits ship their own adapter without
 * peer-depping on any specific framework.
 *
 * Consumer convention:
 *   - Kit: implement `createMongooseAdapter(config): DataAdapter<TDoc>`
 *     in `@classytic/<kit>/adapter`.
 *   - Host: accept `DataAdapter<TDoc>` at the resource boundary; widen
 *     repository inputs through `asRepositoryLike()` once at the
 *     factory; feature-detect optional methods at call sites.
 */

export type {
  AdapterFactory,
  AdapterRepositoryInput,
  AdapterSchemaContext,
  AdapterValidationResult,
  DataAdapter,
  FieldMetadata,
  OpenApiSchemas,
  RelationMetadata,
  RepositoryLike,
  SchemaMetadata,
} from './types.js';
export { asRepositoryLike, isRepository } from './widen.js';
