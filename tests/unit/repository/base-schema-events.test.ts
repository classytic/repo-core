/**
 * `RepositoryBase` construction-time wiring — Standard Schema validation
 * (`schema` / `updateSchema`) and domain-event emission (`events`).
 *
 * Uses a minimal fake kit (in-memory exec) so the lifecycle runs exactly
 * as real kits drive it: `_buildContext` → exec → `_emitAfter`.
 */

import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../../src/events/types.js';
import { RepositoryBase, type RepositoryBaseOptions } from '../../../src/repository/base.js';
import type { StandardSchemaV1 } from '../../../src/schema/standard-schema.js';

/** Minimal Standard Schema: requires a string `name`, trims it (transform). */
const nameSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'test-validator',
    validate: (value) => {
      const doc = value as Record<string, unknown>;
      if (typeof doc?.['name'] !== 'string') {
        return { issues: [{ message: 'Expected string', path: ['name'] }] };
      }
      return { value: { ...doc, name: (doc['name'] as string).trim() } };
    },
  },
};

class FakeRepo extends RepositoryBase {
  constructor(options: Partial<RepositoryBaseOptions> = {}) {
    super({ name: 'Widget', ...options });
  }

  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await this._buildContext('create', { data, options: {} });
    const result = { _id: 'w1', ...(context.data as Record<string, unknown>) };
    await this._emitAfter('create', context, result);
    return result;
  }

  async createMany(dataArray: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const context = await this._buildContext('createMany', { dataArray, options: {} });
    const result = (context.dataArray as Record<string, unknown>[]).map((d, i) => ({
      _id: `w${i}`,
      ...d,
    }));
    await this._emitAfter('createMany', context, result);
    return result;
  }

  async update(
    id: string,
    data: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const context = await this._buildContext('update', { id, data, options });
    const result = { _id: id, ...(context.data as Record<string, unknown>) };
    await this._emitAfter('update', context, result);
    return result;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const context = await this._buildContext('delete', { id, options: {} });
    const result = { deleted: true };
    await this._emitAfter('delete', context, result);
    return result;
  }
}

describe('RepositoryBase — Standard Schema validation', () => {
  it('validates create payloads and applies schema transforms', async () => {
    const repo = new FakeRepo({ schema: nameSchema });
    const doc = await repo.create({ name: '  Alice  ' });
    expect(doc['name']).toBe('Alice'); // transform flowed into the write
  });

  it('throws HttpError 400 with structured validationErrors on failure', async () => {
    const repo = new FakeRepo({ schema: nameSchema });
    await expect(repo.create({ name: 42 })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
      validationErrors: [{ validator: 'test-validator', error: 'name: Expected string' }],
    });
  });

  it('validates every doc in createMany', async () => {
    const repo = new FakeRepo({ schema: nameSchema });
    await expect(repo.createMany([{ name: 'ok' }, { name: 7 }])).rejects.toMatchObject({
      status: 400,
    });
    const docs = await repo.createMany([{ name: ' a ' }, { name: ' b ' }]);
    expect(docs.map((d) => d['name'])).toEqual(['a', 'b']);
  });

  it('leaves update unvalidated unless updateSchema is provided', async () => {
    const repo = new FakeRepo({ schema: nameSchema });
    await expect(repo.update('w1', { name: 99 })).resolves.toBeTruthy();

    const strict = new FakeRepo({ schema: nameSchema, updateSchema: nameSchema });
    await expect(strict.update('w1', { name: 99 })).rejects.toMatchObject({ status: 400 });
  });
});

describe('RepositoryBase — domain-event emission', () => {
  function collector() {
    const published: DomainEvent[] = [];
    return {
      published,
      transport: {
        name: 'memory-test',
        publish: async (event: DomainEvent) => {
          published.push(event);
        },
      },
    };
  }

  it('publishes <resource>.created with resource meta on create', async () => {
    const { published, transport } = collector();
    const repo = new FakeRepo({ events: { transport, source: 'unit-test' } });
    await repo.create({ name: 'Alice' });

    expect(published).toHaveLength(1);
    const event = published[0]!;
    expect(event.type).toBe('widget.created');
    expect(event.meta.resource).toBe('widget');
    expect(event.meta.resourceId).toBe('w1');
    expect(event.meta.source).toBe('unit-test');
    expect(event.meta.id).toBeTruthy();
    expect(event.meta.timestamp).toBeInstanceOf(Date);
    expect((event.payload as Record<string, unknown>)['name']).toBe('Alice');
  });

  it('publishes updated / deleted verbs and forwards actor meta from options', async () => {
    const { published, transport } = collector();
    const repo = new FakeRepo({ events: { transport } });
    await repo.update('w9', { name: 'Bob' }, { userId: 'u1', organizationId: 'org1' });
    await repo.delete('w9');

    expect(published.map((e) => e.type)).toEqual(['widget.updated', 'widget.deleted']);
    expect(published[0]!.meta.userId).toBe('u1');
    expect(published[0]!.meta.organizationId).toBe('org1');
    expect(published[1]!.payload).toEqual({ id: 'w9' });
  });

  it('publishes one created event per createMany doc', async () => {
    const { published, transport } = collector();
    const repo = new FakeRepo({ events: { transport } });
    await repo.createMany([{ name: 'a' }, { name: 'b' }]);
    expect(published.map((e) => e.type)).toEqual(['widget.created', 'widget.created']);
  });

  it('never fails the operation when the transport throws', async () => {
    const repo = new FakeRepo({
      events: {
        transport: {
          name: 'broken',
          publish: async () => {
            throw new Error('kafka down');
          },
        },
      },
    });
    await expect(repo.create({ name: 'Alice' })).resolves.toBeTruthy();
  });

  it('honors the resource override', async () => {
    const { published, transport } = collector();
    const repo = new FakeRepo({ events: { transport, resource: 'inventory-widget' } });
    await repo.create({ name: 'Alice' });
    expect(published[0]!.type).toBe('inventory-widget.created');
  });
});
