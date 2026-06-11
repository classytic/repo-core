/**
 * Standard Schema integration — the validator-agnostic validation slot.
 *
 * [Standard Schema](https://standardschema.dev) is the shared interface
 * implemented by Zod 3.24+, Valibot 1.0+, ArkType 2.0+, Effect Schema and
 * others. Vendoring the interface (officially encouraged — it's a
 * types-only spec designed to be copied) keeps repo-core's zero-dependency
 * guarantee while letting hosts plug ANY conforming validator into a
 * repository:
 *
 * ```ts
 * import { z } from 'zod';
 *
 * const repo = createRepository(UserModel, {
 *   schema: z.object({ name: z.string(), email: z.string().email() }),
 * });
 * await repo.create({ name: 1 }); // throws HttpError 400 with validationErrors
 * ```
 *
 * `RepositoryBase` wires `schema` / `updateSchema` into `before:create` /
 * `before:createMany` / `before:update` hooks at `HOOK_PRIORITY.VALIDATION`
 * — after policy plugins (so tenant-stamped fields are present) and before
 * cache/observability.
 */

import { ERROR_CODES } from '../errors/index.js';
import type { HttpError, ValidationErrorMeta } from '../errors/types.js';

// ──────────────────────────────────────────────────────────────────────
// Vendored spec — keep faithful to @standard-schema/spec v1. One
// type-identical deviation: `readonly Issue[]` shorthand instead of
// `ReadonlyArray<Issue>` (biome lint/style/useConsistentArrayType).
// ──────────────────────────────────────────────────────────────────────

/** The Standard Schema interface. Any conforming validator satisfies it. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  export interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Validates unknown input values. */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The result interface of the validate function. */
  export type Result<Output> = SuccessResult<Output> | FailureResult;

  /** The result interface if validation succeeds. */
  export interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** The non-existent issues. */
    readonly issues?: undefined;
  }

  /** The result interface if validation fails. */
  export interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: readonly Issue[];
  }

  /** The issue interface of the failure output. */
  export interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** The path segment interface of the issue. */
  export interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }

  /** The Standard Schema types interface. */
  export interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }

  /** Infers the input type of a Standard Schema. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  /** Infers the output type of a Standard Schema. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

// ──────────────────────────────────────────────────────────────────────
// Runtime helper
// ──────────────────────────────────────────────────────────────────────

/** Dot-path string from a Standard Schema issue path. */
function issuePath(issue: StandardSchemaV1.Issue): string {
  if (!issue.path || issue.path.length === 0) return '';
  return issue.path
    .map((seg) => String(typeof seg === 'object' && seg !== null && 'key' in seg ? seg.key : seg))
    .join('.');
}

/**
 * Validate `data` against a Standard Schema. Returns the schema's typed
 * output (validators may coerce/transform) or throws an `HttpError` 400
 * carrying `validationErrors` + structured `meta.issues` — the same wire
 * shape every kit's own validation errors serialize to.
 */
export async function validateStandardSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  data: unknown,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  let result = schema['~standard'].validate(data);
  if (result instanceof Promise) result = await result;

  if (result.issues) {
    const validationErrors: ValidationErrorMeta[] = result.issues.map((issue) => ({
      validator: schema['~standard'].vendor,
      error: issuePath(issue) ? `${issuePath(issue)}: ${issue.message}` : issue.message,
    }));
    const error: HttpError = Object.assign(new Error('Validation failed'), {
      status: 400,
      code: ERROR_CODES.VALIDATION,
      validationErrors,
      meta: {
        issues: result.issues.map((issue) => ({
          path: issuePath(issue) || undefined,
          message: issue.message,
        })),
      },
    });
    throw error;
  }

  return result.value as StandardSchemaV1.InferOutput<TSchema>;
}
