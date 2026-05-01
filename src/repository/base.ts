/**
 * Abstract repository base.
 *
 * Owns the hook engine, context builder, and plugin installation — the
 * driver-agnostic plumbing every kit's concrete `Repository` extends.
 * No CRUD methods here on purpose: kits implement them against their
 * driver and invoke `this._runWithHooks('create', context, exec)` to
 * thread plugins through.
 *
 * Kits that want the full StandardRepo surface (findOneAndUpdate, upsert,
 * aggregate, ...) implement the methods but share this hook substrate, so
 * a single plugin works identically against mongokit, sqlitekit, pgkit.
 */

import type { RepositoryContext } from '../context/index.js';
import type { HookListener, HookMode } from '../hooks/index.js';
import { HookEngine } from '../hooks/index.js';
import { type PluginType, validatePluginOrder } from './plugin-types.js';

/** Construction options common to every kit. */
export interface RepositoryBaseOptions {
  /** Stable identifier (model/table name) — surfaces in hook contexts and ordering errors. */
  name: string;
  /** Plugins to install at construction. Order matters — see `PLUGIN_ORDER_CONSTRAINTS`. */
  plugins?: readonly PluginType[];
  /** Emit mode for the hook engine. Default: `'async'`. */
  hooks?: HookMode;
  /** Plugin-order validation mode. Default: `'warn'`. */
  pluginOrderChecks?: 'warn' | 'throw' | 'off';
  /** Optional callback for plugin-order warnings (defaults to `console.warn`). */
  onPluginOrderWarning?: (message: string) => void;
}

/**
 * Base class every driver kit extends. Exposes the hook surface
 * (`on` / `off` / `emit` / `emitAsync`), plugin installation (`use`), and
 * context building (`_buildContext`). Kits layer their CRUD on top.
 */
export abstract class RepositoryBase {
  /** Model/table identifier — set once at construction, read on every hook context. */
  readonly modelName: string;
  /** Public hook engine so plugins + kits dispatch directly without a method wrapper. */
  readonly hooks: HookEngine;

  /**
   * Open-ended property bag so plugins can install methods on the repo
   * (e.g. `softDeletePlugin` adds `repo.restore(id)`). The `unknown` escape
   * hatch keeps the class assignable to the richer `StandardRepo` contract
   * without casts.
   */
  [key: string]: unknown;

  constructor(options: RepositoryBaseOptions) {
    this.modelName = options.name;
    this.hooks = new HookEngine(options.hooks ?? 'async');

    const plugins = options.plugins ?? [];
    for (let i = 0; i < plugins.length; i++) {
      assertValidPlugin(plugins[i] as PluginType, this.modelName, i);
    }
    validatePluginOrder(
      plugins,
      this.modelName,
      options.pluginOrderChecks ?? 'warn',
      options.onPluginOrderWarning,
    );
    for (const plugin of plugins) this.use(plugin);
  }

  /** Install a plugin (object with `apply(repo)` or a plain function). */
  use(plugin: PluginType): this {
    assertValidPlugin(plugin, this.modelName);
    if (typeof plugin === 'function') {
      plugin(this);
    } else {
      plugin.apply(this);
    }
    return this;
  }

  /**
   * Register a hook listener. Lower priority numbers run first.
   * Generic over listener data type so plugins can annotate their handler
   * parameter (e.g. `(ctx: RepositoryContext) => void`) without casting.
   */
  on<TData = unknown>(
    event: string,
    listener: HookListener<TData>,
    options?: { priority?: number },
  ): this {
    this.hooks.on(event, listener as HookListener, options);
    return this;
  }

  /** Remove a specific listener. */
  off<TData = unknown>(event: string, listener: HookListener<TData>): this {
    this.hooks.off(event, listener as HookListener);
    return this;
  }

  /** Remove all listeners for an event (or all events when omitted). */
  removeAllListeners(event?: string): this {
    this.hooks.removeAllListeners(event);
    return this;
  }

  /** Emit fire-and-forget (async errors routed to `error:hook`). */
  emit(event: string, data: unknown): void {
    this.hooks.emit(event, data);
  }

  /** Emit and await every listener in priority order. */
  async emitAsync(event: string, data: unknown): Promise<void> {
    await this.hooks.emitAsync(event, data);
  }

  /**
   * Build a context + run before-hooks. Kits call this at the top of every
   * op, mutate as needed (e.g. compile the filter after plugins have injected
   * scope), perform the native operation, then call `_emitAfter`.
   *
   * **Always awaits before-hooks** regardless of the engine's `hooks` mode.
   * The before-phase is where policy plugins (multi-tenant, soft-delete,
   * validation) inject scope and reject requests — fire-and-forget here
   * would let the driver call run before the filter is augmented. `hooks:
   * 'sync'` only affects `_emitAfter` / `_emitError`, where fire-and-forget
   * is acceptable for observability/metrics listeners.
   */
  async _buildContext<TOptions extends Record<string, unknown>>(
    operation: string,
    inputs: TOptions,
  ): Promise<RepositoryContext> {
    const context: RepositoryContext = {
      operation,
      model: this.modelName,
      ...inputs,
    };
    await this.hooks.emitAsync(`before:${operation}`, context);
    return context;
  }

  /** Emit after-hook. Kits invoke this after the native op succeeds. */
  async _emitAfter(operation: string, context: RepositoryContext, result: unknown): Promise<void> {
    await this.hooks.emitAccordingToMode(`after:${operation}`, { context, result });
  }

  /**
   * Emit error-hook. Swallows any throw from within the hook itself so the
   * original operation's error remains authoritative.
   */
  async _emitError(operation: string, context: RepositoryContext, error: Error): Promise<void> {
    try {
      await this.hooks.emitAccordingToMode(`error:${operation}`, { context, error });
    } catch {
      // Deliberate — an error-hook failure must not override the primary error
      // the caller is about to see.
    }
  }

  /**
   * Cache-plugin escape hatch. When the cache plugin's `before:*` hook
   * finds a hit, it stamps `_cacheHit = true` + `_cachedResult` onto the
   * context. Kits call this helper at the top of every read op right after
   * `_buildContext`. Returns the cached value, or `undefined` when there
   * was no hit (kit proceeds with the native driver call).
   *
   * Returns `undefined` also covers "hit, but the cached value was undefined" —
   * callers typically treat that as a miss since repo methods return null,
   * not undefined, for "not found".
   */
  _cachedValue<T>(context: RepositoryContext): T | undefined {
    if (context['_cacheHit'] !== true) return undefined;
    return context['_cachedResult'] as T | undefined;
  }
}

/**
 * Reject malformed plugin entries before they reach `use()`.
 *
 * Caught the field-reported `new Repository(Model, ['organizationId'], ...)`
 * crash where a tenant-field string array landed in the plugins slot and
 * blew up with `TypeError: plugin.apply is not a function` deep inside the
 * constructor. Validating shape up front turns that into a single, action-
 * able error pointing at the offending index.
 */
function assertValidPlugin(plugin: PluginType, repoName: string, index?: number): void {
  const where = typeof index === 'number' ? `plugin at index ${index}` : 'plugin';
  if (plugin === null || plugin === undefined) {
    throw new TypeError(
      `[repo-core] Repository "${repoName}": ${where} is ${plugin === null ? 'null' : 'undefined'}. ` +
        'Expected a function `(repo) => void` or an object `{ name, apply(repo) }`.',
    );
  }
  if (typeof plugin === 'function') return;
  if (typeof plugin !== 'object') {
    const detail = typeof plugin === 'string' ? `'${plugin}'` : '';
    throw new TypeError(
      `[repo-core] Repository "${repoName}": ${where} has wrong type. ` +
        `Expected a function or { name, apply(repo) } object — got ${typeof plugin} ${detail}. ` +
        'Common cause: `new Repository(Model, [tenantField], opts)` — second argument must be a plugins array.',
    );
  }
  if (typeof (plugin as { apply?: unknown }).apply !== 'function') {
    throw new TypeError(
      `[repo-core] Repository "${repoName}": ${where} is an object but missing \`apply(repo)\`. ` +
        'Expected `{ name: string, apply: (repo) => void }`.',
    );
  }
}
