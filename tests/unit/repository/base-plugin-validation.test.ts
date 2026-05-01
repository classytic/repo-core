/**
 * `RepositoryBase.use()` plugin-shape validation.
 *
 * Reported failure: passing the wrong constructor arg
 * (`new Repository(Model, ['organizationId'], { maxLimit: 200 })`) crashed
 * deep inside `use()` with `TypeError: plugin.apply is not a function`,
 * cascade-failing every test that booted the app. The base must reject
 * malformed plugin entries at construction with a message that points at
 * the offending shape — not let `String.prototype.apply` defer the error
 * to a meaningless stack frame.
 */

import { describe, expect, it } from 'vitest';
import { RepositoryBase } from '../../../src/repository/base.js';
import type { PluginType } from '../../../src/repository/plugin-types.js';

class TestRepo extends RepositoryBase {}

describe('RepositoryBase plugin-shape validation', () => {
  it('throws a descriptive error when a plugin is a string', () => {
    expect(
      () =>
        new TestRepo({
          name: 'TestModel',
          // Mimic the settlement-import bug — caller passed a tenant-field
          // string array where the constructor expected a plugins[] array.
          plugins: ['organizationId' as unknown as PluginType],
          pluginOrderChecks: 'off',
        }),
    ).toThrow(/plugin at index 0[\s\S]+expected[\s\S]+got string/i);
  });

  it('throws when a plugin object is missing `apply`', () => {
    expect(
      () =>
        new TestRepo({
          name: 'TestModel',
          plugins: [{ name: 'broken' } as unknown as PluginType],
          pluginOrderChecks: 'off',
        }),
    ).toThrow(/plugin at index 0[\s\S]+apply/i);
  });

  it('throws when a plugin entry is null', () => {
    expect(
      () =>
        new TestRepo({
          name: 'TestModel',
          plugins: [null as unknown as PluginType],
          pluginOrderChecks: 'off',
        }),
    ).toThrow(/plugin at index 0/i);
  });

  it('accepts a well-formed object plugin', () => {
    let called = false;
    const repo = new TestRepo({
      name: 'TestModel',
      plugins: [
        {
          name: 'ok',
          apply: () => {
            called = true;
          },
        },
      ],
      pluginOrderChecks: 'off',
    });
    expect(repo.modelName).toBe('TestModel');
    expect(called).toBe(true);
  });

  it('accepts a function plugin', () => {
    let called = false;
    const repo = new TestRepo({
      name: 'TestModel',
      plugins: [
        (() => {
          called = true;
        }) as PluginType,
      ],
      pluginOrderChecks: 'off',
    });
    expect(repo.modelName).toBe('TestModel');
    expect(called).toBe(true);
  });

  it('rejects malformed plugins from `use()` post-construction too', () => {
    const repo = new TestRepo({ name: 'TestModel' });
    expect(() => repo.use('organizationId' as unknown as PluginType)).toThrow(
      /plugin[\s\S]+expected[\s\S]+got string/i,
    );
  });
});
