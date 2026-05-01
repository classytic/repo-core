/**
 * `SchemaGenerator<TModel>` interface + `isSchemaGenerator` guard tests.
 *
 * Pinned contract:
 *   1. `SchemaGenerator<TModel>` accepts `(model, options?, context?) =>
 *      CrudSchemas | Record<string, unknown>`. No runtime — it's a type.
 *   2. Functions structurally satisfy `SchemaGenerator<TModel>` via
 *      `satisfies SchemaGenerator<...>`. This is the contract every kit's
 *      schema builder follows (`mongokit/buildCrudSchemasFromModel`,
 *      `sqlitekit/buildCrudSchemasFromTable`, future kits' equivalents).
 *   3. `isSchemaGenerator(value)` returns true for functions with arity
 *      1-3, false otherwise. Conservative — doesn't invoke the function.
 *   4. Kit-native model types narrow through the `TModel` generic, so
 *      mongokit's generator is `SchemaGenerator<Model<unknown>>` and
 *      sqlitekit's is `SchemaGenerator<DrizzleTable>`. Cross-kit utility
 *      code uses `SchemaGenerator<unknown>`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SchemaGenerator, SchemaGeneratorContext } from '../../../src/schema/generator.js';
import { isSchemaGenerator } from '../../../src/schema/generator.js';
import type { CrudSchemas, SchemaBuilderOptions } from '../../../src/schema/types.js';

describe('SchemaGenerator<TModel> — structural alignment', () => {
  it('a 1-arg generator satisfies the contract', () => {
    const gen = ((_model: unknown) => ({
      createBody: { type: 'object', properties: {} },
      updateBody: { type: 'object', properties: {} },
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      listQuery: { type: 'object', properties: {} },
    })) satisfies SchemaGenerator<unknown>;
    expect(typeof gen).toBe('function');
  });

  it('a 3-arg generator satisfies the contract', () => {
    const gen = ((
      _model: unknown,
      _options?: SchemaBuilderOptions,
      _ctx?: SchemaGeneratorContext,
    ): CrudSchemas => ({
      createBody: { type: 'object', properties: {} },
      updateBody: { type: 'object', properties: {} },
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      listQuery: { type: 'object', properties: {} },
    })) satisfies SchemaGenerator<unknown>;
    expect(typeof gen).toBe('function');
  });

  it('TModel narrows to the kit-native model type', () => {
    interface FakeMongoModel {
      schema: { paths: Record<string, unknown> };
    }
    const mongokitGen = ((model: FakeMongoModel): CrudSchemas => {
      // Verify the model is typed correctly inside the generator.
      expectTypeOf(model).toMatchTypeOf<FakeMongoModel>();
      return {
        createBody: { type: 'object', properties: {} },
        updateBody: { type: 'object', properties: {} },
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        listQuery: { type: 'object', properties: {} },
      };
    }) satisfies SchemaGenerator<FakeMongoModel>;
    expect(typeof mongokitGen).toBe('function');
  });

  it('honours SchemaGeneratorContext fields (idField + resourceName)', () => {
    const gen: SchemaGenerator<unknown> = (_model, _options, ctx) => ({
      createBody: { type: 'object', properties: {} },
      updateBody: { type: 'object', properties: {} },
      params: {
        type: 'object',
        properties: {
          [ctx?.idField ?? 'id']: { type: 'string' },
        },
        required: [ctx?.idField ?? 'id'],
      },
      listQuery: { type: 'object', properties: {} },
    });
    const out = gen({}, undefined, { idField: 'sku', resourceName: 'product' }) as CrudSchemas;
    const params = out.params as { properties: Record<string, unknown>; required: string[] };
    expect(params.required).toContain('sku');
  });

  it('return type accepts vendor-extension shapes (kit-native extras)', () => {
    // A kit's output may include `x-ref` etc. — `Record<string, unknown>`
    // in the return union covers it.
    const gen = ((_model: unknown) => ({
      createBody: {
        type: 'object',
        properties: { user: { type: 'string', 'x-ref': 'user' } },
      },
      updateBody: { type: 'object', properties: {} },
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      listQuery: { type: 'object', properties: {} },
      response: { type: 'object', properties: {}, additionalProperties: true },
    })) satisfies SchemaGenerator<unknown>;
    expect(typeof gen).toBe('function');
  });
});

describe('isSchemaGenerator', () => {
  it('returns true for functions with arity 1-3', () => {
    const a = (_m: unknown) => ({});
    const b = (_m: unknown, _o?: unknown) => ({});
    const c = (_m: unknown, _o?: unknown, _ctx?: unknown) => ({});
    expect(isSchemaGenerator(a)).toBe(true);
    expect(isSchemaGenerator(b)).toBe(true);
    expect(isSchemaGenerator(c)).toBe(true);
  });

  it('returns false for nullary functions (no model arg)', () => {
    expect(isSchemaGenerator(() => ({}))).toBe(false);
  });

  it('returns false for functions with arity 4+ (mismatched contract)', () => {
    const tooMany = (_a: unknown, _b: unknown, _c: unknown, _d: unknown) => ({});
    expect(isSchemaGenerator(tooMany)).toBe(false);
  });

  it('returns false for non-functions', () => {
    expect(isSchemaGenerator(undefined)).toBe(false);
    expect(isSchemaGenerator(null)).toBe(false);
    expect(isSchemaGenerator('not-a-fn')).toBe(false);
    expect(isSchemaGenerator({})).toBe(false);
    expect(isSchemaGenerator([])).toBe(false);
    expect(isSchemaGenerator(123)).toBe(false);
  });

  it('does not invoke the function (conservative — no expensive call)', () => {
    let called = false;
    const expensive = (_m: unknown) => {
      called = true;
      return {};
    };
    isSchemaGenerator(expensive);
    expect(called).toBe(false);
  });
});
