/**
 * Hook priority constants for the repository lifecycle.
 *
 * Lower numbers run first. Policy hooks (multi-tenant scope, soft-delete
 * filtering, validation) must run before cache lookup so that tenant and
 * deletion filters are part of the cache key — otherwise one tenant can
 * read another tenant's cached row.
 *
 * Driver-agnostic: both `@classytic/mongokit` and future kits
 * (`pgkit`, `prismakit`) use these same priorities so cross-kit plugins
 * compose identically.
 */
export const HOOK_PRIORITY = {
  /** Policy enforcement — tenant isolation, soft-delete filtering. */
  POLICY: 100,
  /**
   * Input validation — Standard Schema / custom validators. Runs after
   * policy (so tenant-stamped fields are present on the payload) and
   * before cache (an invalid request must never claim a cache slot).
   */
  VALIDATION: 150,
  /** Cache lookup / store — must run after policy so filters are in the key. */
  CACHE: 200,
  /** Observability — audit logging, metrics, telemetry. Must not mutate context. */
  OBSERVABILITY: 300,
  /** Default priority for user-registered hooks with no explicit priority. */
  DEFAULT: 500,
} as const;

/** The numeric type of any `HOOK_PRIORITY` value. */
export type HookPriority = (typeof HOOK_PRIORITY)[keyof typeof HOOK_PRIORITY];
