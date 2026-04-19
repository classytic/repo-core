/**
 * `HOOK_EVENTS` + `HookEventName` unit coverage.
 *
 * The value of this constant is type-level: `repo.on(HOOK_EVENTS.BEFORE_CREATE, …)`
 * becomes a compile error when the constant name is mistyped, while a raw
 * string like `'before:craete'` silently registers a listener that never
 * fires. These tests lock in:
 *
 *   1. Every event name is lowercase-camel past the phase prefix — must
 *      match the op names the kits actually emit (`getById`, not `getbyid`).
 *   2. Three phases (`before` / `after` / `error`) for every op.
 *   3. `HookEventName` narrows to the declared values.
 */

import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, type HookEventName } from '../../../src/hooks/index.js';

describe('HOOK_EVENTS', () => {
  it('has exactly three phases per operation', () => {
    // Group by op (portion after the `phase:` prefix) and assert each has 3.
    const byOp = new Map<string, Set<string>>();
    for (const name of Object.values(HOOK_EVENTS) as readonly string[]) {
      const [phase, op] = name.split(':');
      if (!phase || !op) throw new Error(`Malformed event name: ${name}`);
      const phases = byOp.get(op) ?? new Set();
      phases.add(phase);
      byOp.set(op, phases);
    }
    for (const [op, phases] of byOp) {
      expect(phases, `op "${op}" is missing a phase`).toEqual(
        new Set(['before', 'after', 'error']),
      );
    }
  });

  it('covers every MinimalRepo op', () => {
    const values = new Set(Object.values(HOOK_EVENTS) as readonly string[]);
    const minimalOps = ['create', 'update', 'delete', 'getById', 'getAll'];
    for (const op of minimalOps) {
      expect(values.has(`before:${op}`), `missing before:${op}`).toBe(true);
      expect(values.has(`after:${op}`), `missing after:${op}`).toBe(true);
      expect(values.has(`error:${op}`), `missing error:${op}`).toBe(true);
    }
  });

  it('covers every StandardRepo op', () => {
    const values = new Set(Object.values(HOOK_EVENTS) as readonly string[]);
    const standardOps = [
      'createMany',
      'updateMany',
      'deleteMany',
      'findOneAndUpdate',
      'restore',
      'getByQuery',
      'getOne',
      'findAll',
      'getOrCreate',
      'count',
      'exists',
      'distinct',
    ];
    for (const op of standardOps) {
      expect(values.has(`before:${op}`), `missing before:${op}`).toBe(true);
      expect(values.has(`after:${op}`), `missing after:${op}`).toBe(true);
      expect(values.has(`error:${op}`), `missing error:${op}`).toBe(true);
    }
  });

  it('every key follows SCREAMING_SNAKE with PHASE_OP structure', () => {
    for (const key of Object.keys(HOOK_EVENTS)) {
      expect(key).toMatch(/^(BEFORE|AFTER|ERROR)_[A-Z][A-Z_]*$/);
    }
  });

  it('values are plain event strings ready for repo.on()', () => {
    expect(HOOK_EVENTS.BEFORE_CREATE).toBe('before:create');
    expect(HOOK_EVENTS.AFTER_GET_BY_ID).toBe('after:getById');
    expect(HOOK_EVENTS.ERROR_FIND_ONE_AND_UPDATE).toBe('error:findOneAndUpdate');
  });

  it('HookEventName narrows to exactly the declared values (type-level)', () => {
    // Compile-time assertion: assignments below must typecheck.
    const name1: HookEventName = HOOK_EVENTS.BEFORE_CREATE;
    const name2: HookEventName = 'after:getAll';
    expect(name1).toBe('before:create');
    expect(name2).toBe('after:getAll');
    // @ts-expect-error — typos are rejected at compile time
    const _bad: HookEventName = 'before:craete';
    expect(_bad).toBe('before:craete');
  });
});
