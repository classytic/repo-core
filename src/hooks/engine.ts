/**
 * Priority-sorted hook engine.
 *
 * Drop-in replacement for mongokit's hook machinery, but standalone — no
 * dependency on Mongoose or any driver. Every `RepositoryBase` holds one
 * instance of `HookEngine`; plugins register listeners via
 * `repo.on(event, listener, { priority })`.
 *
 * Determinism invariants the engine guarantees:
 *   1. Listeners run in ascending priority order (lower = earlier).
 *   2. Equal priority → registration order (stable sort).
 *   3. `emitAsync` awaits every listener in order.
 *   4. `emit` (sync-path) dispatches async listeners fire-and-forget,
 *      routing their rejections to `error:hook` to avoid silent loss.
 */

import type { HookListener, HookMode, PrioritizedHook } from './types.js';

/** The default priority assigned when a user omits one on `on(...)`. */
export const DEFAULT_LISTENER_PRIORITY = 500;

export class HookEngine {
  readonly mode: HookMode;
  private readonly hooks: Map<string, PrioritizedHook[]>;

  constructor(mode: HookMode = 'async') {
    this.mode = mode;
    this.hooks = new Map();
  }

  /**
   * Register a listener. Lower priority numbers run first. Equal priorities
   * preserve registration order.
   */
  on(event: string, listener: HookListener, options: { priority?: number } = {}): void {
    const priority = options.priority ?? DEFAULT_LISTENER_PRIORITY;
    const bucket = this.hooks.get(event) ?? [];
    bucket.push({ listener, priority });
    bucket.sort((a, b) => a.priority - b.priority);
    this.hooks.set(event, bucket);
  }

  /** Remove a specific listener. No-op if not registered. */
  off(event: string, listener: HookListener): void {
    const bucket = this.hooks.get(event);
    if (!bucket) return;
    const idx = bucket.findIndex((h) => h.listener === listener);
    if (idx !== -1) bucket.splice(idx, 1);
  }

  /**
   * Remove every listener for a specific event, or every listener entirely.
   * Prefer `off(event, listener)` in plugins — blanket removal invalidates
   * other plugins' hooks (the mongokit footgun the StandardRepo docs warn about).
   */
  removeAllListeners(event?: string): void {
    if (event === undefined) this.hooks.clear();
    else this.hooks.delete(event);
  }

  /**
   * Emit event synchronously — fires every listener but does NOT await.
   * Async listeners that reject route their errors to `error:hook` so the
   * failure isn't swallowed.
   */
  emit(event: string, data: unknown): void {
    const bucket = this.hooks.get(event);
    if (!bucket) return;
    for (const { listener } of bucket) {
      try {
        const result = listener(data);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void (result as Promise<unknown>).catch((err: unknown) => {
            if (event === 'error:hook') return; // don't recurse
            const error = err instanceof Error ? err : new Error(String(err));
            this.emit('error:hook', { event, error });
          });
        }
      } catch (err) {
        if (event === 'error:hook') continue;
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit('error:hook', { event, error });
      }
    }
  }

  /** Emit event and await every listener in priority order. */
  async emitAsync(event: string, data: unknown): Promise<void> {
    const bucket = this.hooks.get(event);
    if (!bucket) return;
    for (const { listener } of bucket) {
      await listener(data);
    }
  }

  /** Emit honoring the engine's configured mode. */
  async emitAccordingToMode(event: string, data: unknown): Promise<void> {
    if (this.mode === 'async') {
      await this.emitAsync(event, data);
      return;
    }
    this.emit(event, data);
  }

  /** Count listeners for an event — useful for tests. */
  count(event: string): number {
    return this.hooks.get(event)?.length ?? 0;
  }

  /**
   * Read-only snapshot of the listener registry.
   *
   * Returns a fresh Map whose buckets are frozen arrays, so callers can
   * inspect priorities/ordering without mutating engine state. Useful for
   * observability (kits often expose this as `repo._hooks` for BC with
   * mongokit ≤3.9 test surface) and for debugging.
   */
  listeners(): Map<string, readonly PrioritizedHook[]> {
    const snapshot = new Map<string, readonly PrioritizedHook[]>();
    for (const [event, bucket] of this.hooks) {
      snapshot.set(event, Object.freeze([...bucket]));
    }
    return snapshot;
  }
}
