/**
 * Env-var helpers for tests. MUST NOT throw at import time — the rule
 * from testing-infrastructure.md §3 is that env checks happen inside
 * a describe/it, never at module load, so a missing key never breaks
 * unrelated suites.
 *
 * repo-core itself is driver-free and has no env requirements; this
 * file exists so tests under `tests/` have a consistent surface to
 * reach for if/when an integration test needs one.
 */

/** Read an env var and fail the current test if unset. Use inside `beforeAll` / `it`. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Required env var not set: ${name}`);
  }
  return value;
}

/** Non-throwing presence check — safe at import time. */
export function hasKey(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== '';
}
