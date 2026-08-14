/**
 * `asReadOnlyRepo` — seal a repository whose rows are owned by ANOTHER writer.
 *
 * ## The failure this exists to make impossible
 *
 * Some tables are projected into a repository for reading — pagination, query
 * parser, filters, OpenAPI, permissions — while a different component owns
 * their writes and enforces invariants the table itself cannot express.
 * Better Auth's `user` / `session` / `account` / `member` collections are the
 * canonical case: it hashes credentials, cascades org membership, revokes
 * sessions, and fires plugin hooks on every mutation.
 *
 * A full read/write repository handed to a generic CRUD layer turns that into
 * one config line away from disaster: `POST /users` writes a row Better Auth
 * never saw, with no password hashing and no hooks. The overlay's docstring
 * saying "read-side" is not a control.
 *
 * So the seal is structural. Write methods throw, and `capabilities.readOnly`
 * is `true` so a host can refuse write ROUTES at boot instead of discovering
 * the wall on the first request. Reads pass through untouched.
 *
 * ## Why a Proxy and not a hand-written wrapper
 *
 * The write surface is open-ended: kits contribute methods (`claim`,
 * `applyTransition`, plugin-added helpers) that no fixed list here would
 * cover, and a wrapper that forwarded unknown properties would leak exactly
 * those. The Proxy inverts the default — a method is readable only if it is
 * on the KNOWN-read list, so a kit's novel write method is sealed by default
 * rather than by remembering to add it.
 */

import type { RepoCapabilities } from './capabilities.js';

/**
 * Methods that only READ. Everything else callable is refused — a novel
 * kit-contributed method is sealed until it is listed here deliberately.
 */
const READ_METHODS: ReadonlySet<string> = new Set([
  'getAll',
  'getById',
  'getOne',
  'getByQuery',
  'getByIds',
  'findAll',
  'count',
  'exists',
  'distinct',
  'aggregate',
  'cursor',
  'stream',
  'watch',
  'explain',
  'getDeleted',
  'isDuplicateKeyError',
  'isTransientConflictError',
]);

/** Non-callable properties that pass through (introspection, not behaviour). */
const PASSTHROUGH_PROPS: ReadonlySet<string> = new Set([
  'idField',
  'modelName',
  'Model',
  'model',
  'db',
  'tables',
  'schema',
  'name',
]);

export interface ReadOnlyRepoOptions {
  /**
   * Who owns writes to these rows, and how a caller should perform them.
   * Surfaces verbatim in the thrown error — a developer hitting the wall
   * needs the alternative, not just the refusal.
   *
   * @example 'Better Auth owns writes to `user`; mutate via auth.api'
   */
  reason: string;
}

/** Error thrown when a write is attempted through a sealed repository. */
export class ReadOnlyRepositoryError extends Error {
  /** The method that was refused. */
  readonly method: string;

  constructor(method: string, reason: string) {
    // The `reason` carries the remedy — it is supplied by whoever sealed the
    // repository and knows what the caller should do instead. A generic
    // suffix here would compete with it and be wrong more often than right.
    super(`Repository is read-only: refused \`${method}()\`. ${reason}.`);
    this.name = 'ReadOnlyRepositoryError';
    this.method = method;
  }
}

/**
 * Wrap `repo` so every write throws {@link ReadOnlyRepositoryError} and
 * `capabilities.readOnly` reports `true`.
 *
 * Reads are forwarded to the original (bound to it, so `this` stays correct
 * for kits that use private state). The wrapper is transparent to type
 * inference: it returns the same type it was given.
 */
export function asReadOnlyRepo<TRepo extends object>(
  repo: TRepo,
  options: ReadOnlyRepoOptions,
): TRepo {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'capabilities') {
        const caps = Reflect.get(target, prop, receiver) as RepoCapabilities | undefined;
        return { ...(caps ?? {}), readOnly: true };
      }
      if (typeof prop === 'symbol' || PASSTHROUGH_PROPS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (READ_METHODS.has(prop)) return value.bind(target);

      // Throws SYNCHRONOUSLY even though the method it replaces is async.
      // Deliberate: a rejected promise from a forgotten `await` becomes an
      // unhandled rejection that may be logged and survived, while this is
      // the one case where survival is the bug. A host reaching here has
      // already bypassed the boot-time route refusal, so the remaining job
      // is to be impossible to ignore. `await` and try/catch behave
      // identically; only a bare `.catch()` chain sees the difference.
      return () => {
        throw new ReadOnlyRepositoryError(prop, options.reason);
      };
    },

    // A write cannot be smuggled in by assignment either.
    set(_target, prop) {
      throw new ReadOnlyRepositoryError(String(prop), options.reason);
    },
  });
}

/** True when a repository (or adapter repository) declares itself read-only. */
export function isReadOnlyRepo(repo: unknown): boolean {
  if (!repo || typeof repo !== 'object') return false;
  const caps = (repo as { capabilities?: { readOnly?: unknown } }).capabilities;
  return caps?.readOnly === true;
}
