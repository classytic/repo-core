/**
 * Better Auth — kit-agnostic registry of which collections each plugin owns.
 *
 * This module ships **zero DB code**. It's the source of truth that every
 * kit's `better-auth` overlay subpath consumes (`@classytic/mongokit/better-auth`,
 * `@classytic/sqlitekit/better-auth`, future `@classytic/prismakit/better-auth`)
 * so the per-kit overlays don't each maintain their own copy of the
 * plugin → collection list.
 *
 * Why repo-core: kits depend on repo-core; arc/hosts consume kits. Putting the
 * registry one level below the kit layer keeps it accessible to every kit
 * without forcing kits to peer-dep each other or to peer-dep arc.
 *
 * @example
 * ```ts
 * import { resolveBetterAuthCollections } from '@classytic/repo-core/better-auth';
 *
 * const names = resolveBetterAuthCollections({
 *   plugins: ['organization'],
 *   extraCollections: ['passkey'],
 * });
 * // → ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation', 'passkey']
 * ```
 */

/**
 * Plugin keys that map to Better Auth collection sets.
 *
 * Only plugins that ship inside the **core `better-auth` package** are listed
 * here. Plugins distributed as separate `@better-auth/*` packages
 * (api-key, passkey, sso, oauth-provider, etc.) evolve independently and
 * should be handled via `extraCollections` — see `resolveBetterAuthCollections`.
 *
 * Plugins that only add *fields* to existing tables (admin, username,
 * phoneNumber, magicLink, emailOtp, anonymous, bearer, multiSession, siwe,
 * lastLoginMethod, genericOAuth, etc.) don't need an entry — kit overlays
 * register schemas with `strict: false` (Mongoose) or pass-through column
 * mappings (SQL), so extra fields round-trip automatically.
 *
 * - `core` — always included; covers `user`, `session`, `account`, `verification`.
 * - `organization` — adds `organization`, `member`, `invitation`.
 * - `organization-teams` — adds `team`, `teamMember` (only when `teams.enabled`).
 * - `twoFactor` — adds `twoFactor`.
 * - `jwt` — adds `jwks`.
 * - `oidcProvider` — adds `oauthApplication`, `oauthAccessToken`, `oauthConsent`.
 * - `oauthProvider` — alias of `oidcProvider` (same schema).
 * - `mcp` — MCP plugin reuses the oidcProvider schema (BA docs are explicit).
 * - `deviceAuthorization` — adds `deviceCode` (RFC 8628 device authorization).
 */
export type BetterAuthPluginKey =
  | 'core'
  | 'organization'
  | 'organization-teams'
  | 'twoFactor'
  | 'jwt'
  | 'oidcProvider'
  | 'oauthProvider'
  | 'mcp'
  | 'deviceAuthorization';

/**
 * Canonical collection lists per plugin. `core` is always implied by
 * `resolveBetterAuthCollections` — callers don't need to pass it.
 *
 * Naming follows BA's mongo adapter (`usePlural: false`) convention. Hosts
 * that opted into `usePlural: true` should pass that flag to the kit overlay,
 * which appends `s` to each name (`user` → `users`).
 */
export const BA_COLLECTIONS_BY_PLUGIN: Record<BetterAuthPluginKey, readonly string[]> = {
  core: ['user', 'session', 'account', 'verification'],
  organization: ['organization', 'member', 'invitation'],
  'organization-teams': ['team', 'teamMember'],
  twoFactor: ['twoFactor'],
  jwt: ['jwks'],
  oidcProvider: ['oauthApplication', 'oauthAccessToken', 'oauthConsent'],
  oauthProvider: ['oauthApplication', 'oauthAccessToken', 'oauthConsent'],
  mcp: ['oauthApplication', 'oauthAccessToken', 'oauthConsent'],
  deviceAuthorization: ['deviceCode'],
};

/**
 * Naive English pluralization that matches Better Auth's `usePlural` behavior:
 * BA's mongo adapter just appends `s` (it doesn't handle irregular nouns —
 * none of its collection names are irregular). Kit overlays mirror this.
 */
export function pluralizeBetterAuthCollection(name: string): string {
  return name.endsWith('s') ? name : `${name}s`;
}

export interface ResolveBetterAuthCollectionsOptions {
  /**
   * Which plugin collection sets to include. `core` is always implied —
   * you don't need to pass it.
   *
   * @default []
   */
  plugins?: BetterAuthPluginKey[];

  /**
   * Additional collection names beyond the built-in plugin set.
   *
   * Use for plugins that ship as separate `@better-auth/*` packages — their
   * collection names live in their own packages and are intentionally not
   * hardcoded here so they can evolve independently.
   *
   * Known names for official separate-package plugins:
   * - `@better-auth/passkey` → `'passkey'`
   * - `@better-auth/sso` → `'ssoProvider'`
   * - `@better-auth/oauth-provider` → already covered by `plugins: ['oauthProvider']`
   *
   * @default []
   */
  extraCollections?: string[];

  /**
   * When BA's adapter was configured with `usePlural: true`, every name is
   * pluralized (`user` → `users`). Must match what you passed to BA's adapter.
   *
   * @default false
   */
  usePlural?: boolean;

  /**
   * Per-collection name override. Applies AFTER pluralization. Use when
   * you've passed `user: { modelName: 'profile' }` (or similar) to
   * `betterAuth()` — pass the same map here so downstream consumers
   * (kit overlays, populate resolution) line up.
   */
  modelOverrides?: Partial<Record<string, string>>;
}

/**
 * Resolve a plugin set + extras to a deduplicated, ordered list of
 * collection names. `core` is always included.
 */
export function resolveBetterAuthCollections(
  options: ResolveBetterAuthCollectionsOptions = {},
): string[] {
  const { plugins = [], extraCollections = [], usePlural = false, modelOverrides = {} } = options;

  // 'core' is always implied — adding it explicitly to the set keeps the
  // dedupe step trivial and lets callers omit it from their plugin list.
  const pluginSet = new Set<BetterAuthPluginKey>(['core', ...plugins]);

  const collected: string[] = [];
  for (const key of pluginSet) {
    for (const name of BA_COLLECTIONS_BY_PLUGIN[key]) {
      collected.push(name);
    }
  }
  for (const name of extraCollections) {
    collected.push(name);
  }

  // Dedupe while preserving insertion order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const canonical of collected) {
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const overridden = modelOverrides[canonical];
    const finalName =
      overridden ?? (usePlural ? pluralizeBetterAuthCollection(canonical) : canonical);
    unique.push(finalName);
  }

  return unique;
}
