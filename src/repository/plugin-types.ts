/**
 * Plugin contract types.
 *
 * A repo-core plugin is either (a) an object with an `apply(repo)` method
 * and a stable `name`, or (b) a plain function taking the repo instance.
 * The `name` field matters because arc's plugin-order validator cross-
 * checks known pairs (soft-delete before batch, multi-tenant before
 * cache) and surfaces mis-ordering at construction time.
 */

import type { RepositoryBase } from './base.js';

/** Object-style plugin — preferred form. Carries a stable `name` for ordering checks. */
export interface Plugin<TRepo extends RepositoryBase = RepositoryBase> {
  /** Stable identifier used by plugin-order validators. */
  readonly name: string;
  apply(repo: TRepo): void;
}

/** Function-style plugin for quick-and-dirty one-off extensions. No ordering guarantees. */
export type PluginFunction<TRepo extends RepositoryBase = RepositoryBase> = (repo: TRepo) => void;

/** Either flavor is accepted by `repo.use(...)`. */
export type PluginType<TRepo extends RepositoryBase = RepositoryBase> =
  | Plugin<TRepo>
  | PluginFunction<TRepo>;

/**
 * Ordered pairs that produce wrong behavior when installed out of order.
 * Each entry: `[mustComeFirst, mustComeAfter, reason]`.
 *
 * Surfaced by `validatePluginOrder` at repository construction time.
 */
export const PLUGIN_ORDER_CONSTRAINTS: readonly (readonly [string, string, string])[] = [
  [
    'soft-delete',
    'batch-operations',
    'soft-delete must precede batch-operations so bulk deletes/updates see the soft-delete filter',
  ],
  [
    'multi-tenant',
    'cache',
    'multi-tenant must precede cache so tenant scoping is baked into cache keys (prevents cross-tenant cache poisoning)',
  ],
  [
    'multi-tenant',
    'soft-delete',
    'multi-tenant should precede soft-delete so tenant scope is applied before deletion-state filter',
  ],
];

/**
 * Assert plugin-install order. Emits a `warn` (default) or throws based on
 * mode. Plain-function plugins (no `name`) are skipped — no false positives.
 */
export function validatePluginOrder(
  plugins: readonly PluginType[],
  repoName: string,
  mode: 'warn' | 'throw' | 'off' = 'warn',
  onWarn: (message: string) => void = (m) => {
    // biome-ignore lint/suspicious/noConsole: intentional — plugin-ordering warning surface
    console.warn(m);
  },
): void {
  if (mode === 'off') return;
  const names = plugins.map((p) => (typeof p === 'function' ? undefined : p.name));

  for (const [first, after, reason] of PLUGIN_ORDER_CONSTRAINTS) {
    const firstIdx = names.indexOf(first);
    const afterIdx = names.indexOf(after);
    if (firstIdx === -1 || afterIdx === -1) continue;
    if (firstIdx < afterIdx) continue;

    const message =
      `[repo-core] Repository "${repoName}": plugin order issue — ${reason}. ` +
      `Got: [..., '${after}' at index ${String(afterIdx)}, '${first}' at index ${String(firstIdx)}]. ` +
      `Swap them, or pass { pluginOrderChecks: 'off' } to silence.`;

    if (mode === 'throw') throw new Error(message);
    onWarn(message);
  }
}
