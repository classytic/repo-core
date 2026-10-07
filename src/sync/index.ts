/**
 * The sync contracts kits implement and a sync engine (`@classytic/arc-sync`) consumes:
 *
 *   - `ChangeLogStore` — the server's change FEED: append-only, commit-ordered, tombstones for
 *     deletes, opaque cursors a client resumes from.
 *   - `CommandStreamStore` — per-client COMMAND STREAMS: one recorded verdict per sequence number,
 *     committed in the transaction of the command's effects.
 *
 * Contracts only; `MemoryChangeLogStore` / `createMemoryCommandStreamStore` are the references,
 * and `@classytic/repo-core/testing` holds the conformance suites every durable store passes.
 *
 * ## Feed semantics (stores MUST honor)
 *
 * 1. **Cursors are opaque, totally ordered per store, in COMMIT order.** A reader must never
 *    checkpoint past an entry that commits later.
 * 2. **`append` joins the caller's transaction** when given a `session`.
 * 3. **Deletes are tombstones**, never gaps.
 * 4. **`since` is exclusive** of the cursor and returns entries in cursor order.
 * 5. **`prune` keeps the latest state and advertises its horizon**; an older cursor gets
 *    `CursorExpiredError` and resyncs.
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
   * A client ignores an entry not newer than the version it holds.
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
  /**
   * Scopes every tenant reads whatever their entries' tenant (company-wide resources: the catalog
   * every branch sells from). Only meaningful with `tenantId`; still narrowed by `scopes`.
   */
  readonly sharedScopes?: readonly string[];
}

export interface ChangesPage<TDoc = unknown> {
  readonly changes: readonly ChangeEntry<TDoc>[];
  /** Checkpoint AFTER applying this page — echo into the next `since`. */
  readonly cursor: string;
  /** True → more entries exist; pull again immediately. */
  readonly hasMore: boolean;
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
    const { limit = 500, scopes, tenantId, sharedScopes } = options;
    const filtered = this.entries.filter(
      (e) =>
        e.cursor > cursor &&
        (!scopes || scopes.includes(e.scope)) &&
        (tenantId === undefined || e.tenantId === tenantId || !!sharedScopes?.includes(e.scope)),
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

// ============================================================================
// Command streams — the server side of a command-sync protocol
// ============================================================================

/** `resolved`: a refused command settled afterwards by a recorded resolution. */
export type CommandOutcome = 'applied' | 'rejected' | 'blocked' | 'resolved';

/** The one outcome recorded for one command — and for its `seq` on its stream. */
export interface CommandVerdictRecord {
  readonly commandId: string;
  readonly stream: string;
  readonly seq: number;
  readonly outcome: CommandOutcome;
  /** Why it was rejected or blocked — a stable code. */
  readonly code?: string;
  /** `fingerprintRequest` of the command: a retry with other bytes under the same id is a fault. */
  readonly fingerprint: string;
  /** The command's bytes, kept while it is refused — a resolution re-evaluates them unchanged. */
  readonly body?: string;
  /** What a `blocked` command waits on — how a resolution finds the dependants to re-evaluate. */
  readonly dependsOn?: readonly string[];
  /** On a `resolved` verdict: the decision that settled it, and who made it. */
  readonly resolution?: { readonly action: string; readonly by: string; readonly at: string };
}

/** A device-minted id the server resolved to one of its own records (a matched customer, a merged shift). */
export interface CommandAliasRecord {
  readonly tenantId: string;
  readonly localId: string;
  readonly serverId: string;
}

export interface CommandStreamRecord {
  /** The tenant the stream was bound to by its first command. */
  readonly tenantId: string;
  /** Highest seq with a recorded verdict; every seq up to it has one. */
  readonly processed: number;
}

/** One store transaction. Pass `session` to the feed's `append` and to every domain write. */
export interface CommandStreamTx {
  readonly session?: unknown;
}

/**
 * Per-client command streams. Every method but `transaction` runs inside one; the transaction
 * commits stream, verdict, feed entries and the domain's writes together, or none of them.
 */
export interface CommandStreamStore<TTx extends CommandStreamTx = CommandStreamTx> {
  /** The feed the domain's writes are captured into — verdicts are appended to it too. */
  readonly changes: ChangeLogStore;
  /**
   * Commit when `work` returns, discard everything when it throws. Two transactions moving one
   * stream must SERIALISE (a retried write conflict, a lock): neither may commit on a stale read.
   */
  transaction<T>(work: (tx: TTx) => Promise<T>): Promise<T>;
  stream(tx: TTx, id: string): Promise<CommandStreamRecord | null>;
  /** Move `from` → `to`, creating the stream (bound to `tenantId`) at `from === 0`. False when not at `from`. */
  advance(tx: TTx, id: string, tenantId: string, from: number, to: number): Promise<boolean>;
  verdict(tx: TTx, commandId: string): Promise<CommandVerdictRecord | null>;
  /** Record a verdict, replacing the command's earlier one (a resolution settles a refusal). */
  record(tx: TTx, verdict: CommandVerdictRecord): Promise<void>;
  /** The `blocked` verdicts waiting on `commandId`, in seq order. */
  blockedOn(tx: TTx, commandId: string): Promise<CommandVerdictRecord[]>;
  /** Record that `localId` names `serverId` in this tenant. One alias per local id. */
  alias(tx: TTx, alias: CommandAliasRecord): Promise<void>;
  aliasOf(tx: TTx, tenantId: string, localId: string): Promise<string | null>;
}

interface MemoryStreamState {
  streams: Map<string, CommandStreamRecord>;
  verdicts: Map<string, CommandVerdictRecord>;
  aliases: Map<string, string>;
}

/**
 * The reference `CommandStreamStore`: transactions run one at a time over a copy of the state, and
 * the feed entries appended with their `session` reach `changes` only on commit.
 */
export function createMemoryCommandStreamStore(
  feed: ChangeLogStore = new MemoryChangeLogStore(),
): CommandStreamStore {
  let state: MemoryStreamState = { streams: new Map(), verdicts: new Map(), aliases: new Map() };
  const aliasKey = (tenantId: string, localId: string) => `${tenantId} ${localId}`;
  let queue: Promise<unknown> = Promise.resolve();
  interface Tx extends CommandStreamTx {
    readonly state: MemoryStreamState;
    readonly appends: Parameters<ChangeLogStore['append']>[0][];
  }
  const stateOf = (tx: CommandStreamTx) => (tx as Tx).state;

  const changes: ChangeLogStore = {
    append(entry, options) {
      const tx = options?.session as Tx | undefined;
      if (!tx) return feed.append(entry);
      tx.appends.push(entry);
      return Promise.resolve({ ...entry, cursor: '', at: new Date() });
    },
    since: (cursor, options) => feed.since(cursor, options),
    latestCursor: (options) => feed.latestCursor(options),
  };

  return {
    changes,
    transaction(work) {
      const run = queue.then(async () => {
        const tx = {
          state: {
            streams: new Map(state.streams),
            verdicts: new Map(state.verdicts),
            aliases: new Map(state.aliases),
          },
          appends: [],
        } as unknown as Tx & { session: Tx };
        tx.session = tx;
        const result = await work(tx);
        state = tx.state;
        for (const entry of tx.appends) await feed.append(entry);
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    stream: async (tx, id) => stateOf(tx).streams.get(id) ?? null,
    async advance(tx, id, tenantId, from, to) {
      const streams = stateOf(tx).streams;
      const current = streams.get(id);
      if ((current?.processed ?? 0) !== from) return false;
      streams.set(id, { tenantId: current?.tenantId ?? tenantId, processed: to });
      return true;
    },
    verdict: async (tx, commandId) => stateOf(tx).verdicts.get(commandId) ?? null,
    record: async (tx, verdict) => void stateOf(tx).verdicts.set(verdict.commandId, verdict),
    blockedOn: async (tx, commandId) =>
      [...stateOf(tx).verdicts.values()]
        .filter((v) => v.outcome === 'blocked' && v.dependsOn?.includes(commandId))
        .sort((a, b) => a.seq - b.seq),
    async alias(tx, { tenantId, localId, serverId }) {
      const aliases = stateOf(tx).aliases;
      const existing = aliases.get(aliasKey(tenantId, localId));
      if (existing !== undefined && existing !== serverId) {
        throw new Error(`[repo-core:sync] "${localId}" already names "${existing}"`);
      }
      aliases.set(aliasKey(tenantId, localId), serverId);
    },
    aliasOf: async (tx, tenantId, localId) =>
      stateOf(tx).aliases.get(aliasKey(tenantId, localId)) ?? null,
  };
}
