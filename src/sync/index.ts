/**
 * Change-log / cursor contract — the data-sync spine for offline-first and
 * incremental replication (`arc-sync`-style capability packages, POS offline,
 * bulk delta export, cross-service read models).
 *
 * Synthesized from the proven protocols, taking the best of each:
 *
 *   - CouchDB `_changes`      → append-only feed, TOMBSTONES for deletes,
 *                               client checkpoints
 *   - Drive/Graph delta APIs  → OPAQUE server-issued cursors (`deltaLink` /
 *                               `startPageToken`) — clients never parse them
 *   - Mongo change streams    → resumable, ordered, per-scope feeds
 *   - Replicache push/pull    → client mutation ids for idempotent PUSH,
 *                               server-authoritative conflict verdicts
 *
 * CONTRACT ONLY — storage-agnostic (repo-core is the cross-kit contract home,
 * like DataAdapter/EventTransport/IdempotencyStore). `MemoryChangeLogStore` is
 * the reference impl. Durable stores + capture plugins live in the KITS
 * (mongokit/prismakit/sqlitekit repository plugins); the HTTP surface
 * (`/sync/pull`, `/sync/push`) is an arc module; arc re-exports this contract
 * at `@classytic/arc/sync`. repo-core is source of truth.
 *
 * ## Required semantics (stores MUST honor)
 *
 * 1. **Cursors are opaque, totally ordered per store.** Clients echo them
 *    verbatim. A cursor from one store/scope-set is meaningless elsewhere.
 * 2. **`append` is ordered and atomic with the business write** when a
 *    `session` is provided (same transaction — the outbox discipline).
 * 3. **Deletes are tombstones**, never gaps. A client at cursor C must be able
 *    to converge by applying every entry after C — including deletions.
 * 4. **`since` is exclusive** of the given cursor and returns entries in
 *    cursor order. `hasMore: true` means call again with the new cursor.
 * 5. **Compaction (`prune`) may drop superseded intermediate versions but
 *    NEVER the latest state or an un-consumed tombstone horizon** — a store
 *    advertises its horizon so clients older than it do a full resync.
 */

// ============================================================================
// Entries
// ============================================================================

/** What happened to a document. Field-level patches are deliberately out of
 *  scope — version-checked upserts + server authority beat CRDT complexity
 *  for ERP data (the Sheets/Replicache position, not the Figma one). */
export type ChangeOp = 'upsert' | 'delete';

export interface ChangeEntry<TDoc = unknown> {
  /** Which logical collection/resource this change belongs to (e.g. `pos-order`). */
  readonly scope: string;
  /** Document identity within the scope. */
  readonly docId: string;
  readonly op: ChangeOp;
  /**
   * Monotonic per-document version — the optimistic-concurrency token.
   * Conflict rule: a push carrying `baseVersion < current` is a conflict.
   */
  readonly version: number;
  /** Full document snapshot for `upsert`; absent for `delete` (tombstone). */
  readonly doc?: TDoc;
  /** Tenant partition (organizationId) — sync feeds are tenant-scoped. */
  readonly tenantId?: string;
  /** Server clock at capture — informational; ORDERING comes from the cursor. */
  readonly at: Date;
  /** Opaque position of THIS entry in the feed (assigned by the store). */
  readonly cursor: string;
}

// ============================================================================
// Pull (server → client)
// ============================================================================

export interface ChangesSinceOptions {
  /** Max entries to return. Stores should default sensibly (e.g. 500). */
  readonly limit?: number;
  /** Restrict to these scopes (a client syncs the resources it opted into). */
  readonly scopes?: readonly string[];
  /** Tenant partition — REQUIRED by multi-tenant stores. */
  readonly tenantId?: string;
}

export interface ChangesPage<TDoc = unknown> {
  readonly changes: ReadonlyArray<ChangeEntry<TDoc>>;
  /** Checkpoint AFTER applying this page — echo into the next `since`. */
  readonly cursor: string;
  /** True → more entries exist; pull again immediately. */
  readonly hasMore: boolean;
}

// ============================================================================
// Push (client → server) — Replicache-style idempotent mutations
// ============================================================================

export interface PushMutation<TDoc = unknown> {
  readonly scope: string;
  readonly docId: string;
  readonly op: ChangeOp;
  /** Version the client last saw — the optimistic-concurrency precondition. */
  readonly baseVersion?: number;
  readonly doc?: TDoc;
  /**
   * Client-unique id (`<clientId>:<seq>`) — replays of the same id MUST be
   * acknowledged as already-applied, never re-executed (at-least-once safe).
   */
  readonly mutationId: string;
}

export type PushVerdictStatus = 'applied' | 'already_applied' | 'conflict' | 'rejected';

export interface PushVerdict<TDoc = unknown> {
  readonly mutationId: string;
  readonly status: PushVerdictStatus;
  /** Authoritative post-push version (also on conflict: the WINNING version). */
  readonly version?: number;
  /** Authoritative doc on conflict so the client can rebase (server wins). */
  readonly current?: TDoc;
  readonly reason?: string;
}

// ============================================================================
// Store contract
// ============================================================================

export interface ChangeLogAppendOptions {
  /** DB session/transaction handle — append atomically with the business write. */
  readonly session?: unknown;
}

export interface ChangeLogStore<TDoc = unknown> {
  /** Record a change. `cursor`/`at` are ASSIGNED by the store; callers pass the rest. */
  append(
    entry: Omit<ChangeEntry<TDoc>, 'cursor' | 'at'>,
    options?: ChangeLogAppendOptions,
  ): Promise<ChangeEntry<TDoc>>;

  /** Entries strictly AFTER `cursor` (empty string = from the beginning). */
  since(cursor: string, options?: ChangesSinceOptions): Promise<ChangesPage<TDoc>>;

  /** The current head checkpoint — what a fresh client stores after a full load. */
  latestCursor(options?: Pick<ChangesSinceOptions, 'tenantId' | 'scopes'>): Promise<string>;

  /**
   * Compact entries older than `before`, keeping per-doc latest state.
   * Returns the new HORIZON cursor: clients checkpointed before it must full-resync.
   */
  prune?(before: Date): Promise<string>;
}

/** Client checkpoint older than the store's compaction horizon → full resync. */
export class CursorExpiredError extends Error {
  constructor(
    public readonly cursor: string,
    public readonly horizon: string,
  ) {
    super(
      `[repo-core:sync] cursor "${cursor}" predates the compaction horizon — full resync required.`,
    );
    this.name = 'CursorExpiredError';
  }
}

// ============================================================================
// Reference implementation — in-memory, single process (tests / dev)
// ============================================================================

export class MemoryChangeLogStore<TDoc = unknown> implements ChangeLogStore<TDoc> {
  private entries: ChangeEntry<TDoc>[] = [];
  private seq = 0;

  async append(
    entry: Omit<ChangeEntry<TDoc>, 'cursor' | 'at'>,
    _options?: ChangeLogAppendOptions,
  ): Promise<ChangeEntry<TDoc>> {
    // Lexicographically ordered opaque cursor (zero-padded sequence).
    const cursor = String(++this.seq).padStart(16, '0');
    const full: ChangeEntry<TDoc> = { ...entry, cursor, at: new Date() };
    this.entries.push(full);
    return full;
  }

  async since(cursor: string, options: ChangesSinceOptions = {}): Promise<ChangesPage<TDoc>> {
    const { limit = 500, scopes, tenantId } = options;
    const filtered = this.entries.filter(
      (e) =>
        e.cursor > cursor &&
        (!scopes || scopes.includes(e.scope)) &&
        (tenantId === undefined || e.tenantId === tenantId),
    );
    const page = filtered.slice(0, limit);
    const last = page[page.length - 1];
    return {
      changes: page,
      cursor: last ? last.cursor : cursor,
      hasMore: filtered.length > page.length,
    };
  }

  async latestCursor(): Promise<string> {
    const last = this.entries[this.entries.length - 1];
    return last ? last.cursor : '';
  }
}
