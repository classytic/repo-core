/**
 * `@classytic/repo-core/cleanup` — the framework-free **cleanup provider step**
 * contract (data-cleanup / retention design §6.3, §6.6).
 *
 * A domain kernel (`@classytic/flow`, `@classytic/order`, `@classytic/facts`,
 * `@classytic/ledger`, …) exports one or more `CleanupStep`s for the data it
 * owns — the unit retention.md §6.6 calls "cleanup recipe steps." A host
 * (`be-prod`) composes ordered steps into a full Cleanup Center recipe.
 *
 * This contract lives in repo-core — NOT in `@classytic/arc` — on purpose:
 *
 *   - Kernels already depend on repo-core (it owns the chunked purge mechanics,
 *     §6.3) and MUST stay free of any host-framework dependency. A kernel that
 *     imported `@classytic/arc/cleanup` would invert the layering.
 *   - Arc's Cleanup Center framework (`@classytic/arc/cleanup`) imports THIS
 *     contract and folds `CleanupStep[]` into an arc `CleanupRecipe` via its
 *     `recipeFromSteps()` composer. One shape, two consumers, zero cycle.
 *
 * A step is a PURE PROVIDER: it knows only how to estimate / execute / verify a
 * slice of its own data. It never authorizes a superadmin, reads go-live state,
 * speaks HTTP, or opens a Mongo transaction the host didn't hand it. It reuses
 * repo-core's own chunked-purge envelope (`TenantPurgeResult` / progress) under
 * the hood; this contract is the composable wrapper around that envelope.
 */

/**
 * Framework-free ambient a cleanup step reads. A structural SUBSET of any host
 * cleanup context (e.g. arc's `CleanupContext`), so passing the host context
 * straight through type-checks — no adapter object required.
 */
export interface CleanupStepContext {
  /** Injected clock — steps never call `new Date()` directly (testability). */
  readonly now: Date;
  /** Cooperative cancellation — observed between chunks. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opaque host-provided ambient scope (resolved company/branch, feature
   * gates, …). MUST be JSON-serializable — a host may persist it on a durable
   * run so a worker in another process rebuilds the exact operation context.
   * A step reads only what it declared it needs; nobody else inspects it.
   */
  readonly ambient?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Operator-supplied recipe parameters (branch id, created-before date, module
   * set, …). Opaque + host-validated at the edge; a step reads/parses the keys
   * it declares. Recipes are boot-time singletons, so parameters arrive HERE at
   * plan/execute time rather than being closed over at construction. The host
   * composer threads the plan's sealed parameters through unchanged, so a
   * worker replays the exact same op.
   */
  readonly parameters?: Readonly<Record<string, unknown>> | undefined;
  /** Optional structured logger. */
  readonly logger?: CleanupStepLogger | undefined;
}

export interface CleanupStepLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** One committed chunk's progress — folded into the host run's bounded summary. */
export interface CleanupStepProgress {
  readonly resource: string;
  /** Cumulative rows processed by THIS step so far. */
  readonly processed: number;
  /** Opaque resume cursor (keyset position) for observability. */
  readonly cursor?: string | undefined;
}

/**
 * Execution-time context — adds progress reporting + a durable-cancellation
 * probe. Both are optional so a step is trivially runnable in a unit test with
 * a bare `CleanupStepContext`.
 */
export interface CleanupStepExecuteContext extends CleanupStepContext {
  /** Report one committed chunk. Call AFTER the chunk's write commits. */
  onProgress?(update: CleanupStepProgress): void | Promise<void>;
  /**
   * Throw the host's cancellation error if a cancel was requested for this run.
   * Cheap to call between chunks; backed by the host's durable `cancelRequested`
   * flag (source of truth) plus the in-process `signal`. Absent in a bare test
   * context — treat as "never cancelled."
   */
  throwIfCancelled?(): void | Promise<void>;
}

/**
 * One preview line — maps 1:1 onto a host plan item. A business record class
 * (`'sales facts'`, `'journal entries'`), never a collection name.
 */
/**
 * What a step's `estimated` COUNTS. Absent ⇒ `'remove'`.
 *
 * `destructive: false` is NOT a substitute: it is true of both a protective
 * guard (counts records it defends) and a projection rebuild (counts records it
 * recomputes), and those mean opposite things in a "records to remove" headline.
 * A guard reporting 173 protected journal entries once pushed that headline to
 * 540 on a plan that removed 367 — a plausible, internally consistent, wrong
 * number shown at the exact moment an operator authorises destruction.
 */
export type CleanupStepDisposition = "remove" | "protect" | "rebuild";

export interface CleanupStepEstimate {
  readonly resource: string;
  /** Estimated records this step would affect. */
  readonly estimated: number;
  /**
   * Whether `estimated` counts records REMOVED, PROTECTED, or REBUILT.
   * Defaults to `'remove'`, so every existing purge step is unchanged and only
   * a step that means something else has to say so.
   */
  readonly disposition?: CleanupStepDisposition | undefined;
  /** What this step RETAINS (e.g. `'measures kept, PII redacted'`). */
  readonly retained?: string | undefined;
  /**
   * Domain blockers preventing this step (e.g. `'POSTED_BOOKS_IMMUTABLE'`,
   * `'OPEN_TRANSFER'`). A non-empty list is a HARD STOP — the host refuses to
   * execute until the operator resolves it. Blockers are DOMAIN facts, never a
   * permission decision (that is the host's job).
   */
  readonly blockers?: readonly string[] | undefined;
  /**
   * Non-blocking warnings surfaced to the operator (e.g. "rebuild may take
   * several minutes on this generation").
   */
  readonly warnings?: readonly string[] | undefined;
}

/** One executed step's outcome — maps onto a host step result. */
export interface CleanupStepOutcome {
  readonly resource: string;
  /** Rows this step actually processed (deleted / redacted / rebuilt). */
  readonly processed: number;
  /**
   * `false` iff the step failed. The host composer STOPS the recipe on the
   * first `ok: false` (retention §8: never return success on a provider
   * failure) and marks the run `failed`/`partial`. A step MUST NOT swallow a
   * failure and report `ok: true`.
   */
  readonly ok: boolean;
  /** Failure message when `ok: false`. */
  readonly error?: string | undefined;
  /** Opaque resume cursor for observability. */
  readonly cursor?: string | undefined;
}

/** One post-check — maps onto a host verification check (§9). */
export interface CleanupStepCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string | undefined;
}

/**
 * A cleanup PROVIDER STEP — the unit a domain kernel exports for data it owns
 * (retention design §6.6). Composed by the host into an ordered recipe.
 *
 * Idempotency + chunking are the step's responsibility: `execute` must be safe
 * to re-run after a crash/retry (keyset progression, dedupe-by-occurrence, or a
 * naturally-idempotent rebuild), and must observe `signal` / `throwIfCancelled`
 * between chunks so a cancel lands between committed batches, never mid-write.
 */
export interface CleanupStep {
  /** Stable machine id, unique within a recipe. */
  readonly id: string;
  /** Logical resource label for the preview (e.g. `'sales facts'`). */
  readonly resource: string;
  /**
   * `true` if the step deletes/redacts data; `false` for a pure rebuild
   * (§4.3 — rebuilding a projection is not destructive to source data). A
   * recipe is destructive iff ANY of its steps is.
   */
  readonly destructive: boolean;
  /**
   * Projection / scaffolding rebuilds this step performs AFTER its cleanup —
   * surfaced in the preview's `rebuildActions` (e.g. `'rebuild sales rollup'`).
   */
  readonly rebuildActions?: readonly string[] | undefined;
  /** Preview WITHOUT mutating. Idempotent + side-effect-free. */
  estimate(ctx: CleanupStepContext): Promise<CleanupStepEstimate>;
  /** Do the work. Chunked, idempotent, cancellation-aware. */
  execute(ctx: CleanupStepExecuteContext): Promise<CleanupStepOutcome>;
  /**
   * Post-checks — the step owns what "clean" means for its data (§9: a delete
   * count alone is never success). Optional: a pure-rebuild step may skip it,
   * though verifying the watermark/counts is strongly encouraged.
   */
  verify?(ctx: CleanupStepContext): Promise<readonly CleanupStepCheck[]>;
}
