/**
 * Cross-runtime `scheduleBackground` — Node vs edge runtimes.
 *
 * The cache layer's SWR refresh defers via `scheduleBackground`. On
 * Node we want `setImmediate` (post-I/O); on Cloudflare Workers /
 * Deno Deploy / browser we fall back to `setTimeout(0)`. Both
 * primitives guarantee the callback runs AFTER the current sync block
 * + microtask queue — exactly what bg-refresh wants.
 *
 * `scheduleBackground` resolves the right primitive at module load,
 * so testing the fallback requires reloading the module with the
 * global stubbed. Vitest's `vi.resetModules` + dynamic `import()`
 * gives us that in-test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('scheduleBackground — runtime detection', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses setImmediate when available (Node / Bun)', async () => {
    const setImmediateSpy = vi.fn((cb: () => void) => {
      cb();
      return undefined as unknown as NodeJS.Immediate;
    });
    vi.stubGlobal('setImmediate', setImmediateSpy);

    const { scheduleBackground } = await import('../../../src/cache/runtime.js');
    let ran = false;
    scheduleBackground(() => {
      ran = true;
    });

    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(ran).toBe(true);
  });

  it('falls back to setTimeout when setImmediate is absent (Workers / Deno / browser)', async () => {
    // Stub setImmediate to undefined — emulates an edge runtime.
    vi.stubGlobal('setImmediate', undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const { scheduleBackground } = await import('../../../src/cache/runtime.js');
    await new Promise<void>((resolve) => {
      scheduleBackground(() => {
        resolve();
      });
    });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(0);
  });

  it('callback runs AFTER current sync block + microtasks', async () => {
    const events: string[] = [];

    const { scheduleBackground } = await import('../../../src/cache/runtime.js');
    scheduleBackground(() => events.push('bg'));

    events.push('sync');
    await Promise.resolve(); // microtask
    events.push('after-microtask');

    // Wait long enough for setImmediate (or setTimeout(0)) to fire.
    await new Promise((r) => setTimeout(r, 5));

    // bg fired AFTER sync and AFTER microtask — exactly the SWR contract.
    expect(events).toEqual(['sync', 'after-microtask', 'bg']);
  });
});
