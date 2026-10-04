/**
 * Idempotency — the ONE contract for "run this command at most once per key".
 *
 * **To make a command idempotent, call {@link runIdempotent} with an
 * {@link IdempotencyClaimStore}.** Never hand-roll a "done" flag, a unique index
 * checked after the side effect, or a per-module claims table: each of those
 * has shipped here, and each double-applied or blocked on a crash without
 * erroring.
 *
 * | layer | owns |
 * |---|---|
 * | this module | identity, fingerprint, lease, the decision, the store PORT, the runner |
 * | a persistence kit (`mongokit`, …) | a store — must pass `runIdempotencyStoreConformance` (`./testing`) |
 * | arc | HTTP: the header, required keys, response replay |
 * | a kernel / spine module | the operation name and scope (`pos.checkout`, `{ organizationId }`) |
 *
 * Lives in repo-core for the reason `./lock` does: the store contract is driver-free — any
 * store with a unique key and a conditional update implements it — and every kit already
 * depends on this package.
 *
 * ## The three-valued outcome is the point
 *
 * {@link ClaimOutcome} is `claimed | replayed | in_flight`, and **`in_flight` is
 * not a failure.** A concurrent attempt holding a live lease means the answer is
 * *not yet known*, exactly like a provider timeout: the work may be about to
 * succeed. Mapping it onto an error licenses the caller to retry the mutation,
 * and if the first attempt lands that is a double-apply — the same asymmetry
 * that makes `unknown` a required payment outcome. The correct handling is to
 * wait out {@link InFlightDecision.retryAfterMs} and ask again, never to
 * re-execute.
 *
 * ## Two identifiers that must not be confused
 *
 * - **`key`** — caller-supplied, STABLE across retries of one logical command.
 *   Derive it deterministically; a random fallback defeats deduplication while
 *   looking correctly wired.
 * - **`leaseToken`** — minted fresh per ATTEMPT, and deliberately random. It
 *   answers "am I still the attempt that owns this claim?", so two attempts
 *   must never mint the same one. Deriving it would make a takeover
 *   indistinguishable from the attempt it replaced.
 */

import { contentHash } from '../hash/index.js';

/** Deepest body {@link fingerprintRequest} accepts — MongoDB's own document limit. */
export const MAX_FINGERPRINT_DEPTH = 100;

/** Default crash-window lease, matching `@classytic/cart`'s proven 30s. */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * Persisted state of a claim.
 *
 * `failed` is TERMINAL and replayable: a command that failed deterministically
 * must fail the same way on retry, or the caller learns a different answer to
 * the same question. It is not a licence to re-execute.
 */
export type ClaimState = 'in_flight' | 'succeeded' | 'failed';

/**
 * What a claim attempt is allowed to do next.
 *
 * - `claimed` — this attempt owns the claim; EXECUTE the command.
 * - `replayed` — a terminal record exists; RETURN its stored result, execute nothing.
 * - `in_flight` — another live attempt owns it; WAIT and re-ask. **Not a failure.**
 */
export type ClaimOutcome = 'claimed' | 'replayed' | 'in_flight';

/** The stored outcome of a completed command — replayed verbatim to retries. */
export type ClaimResult<TValue = unknown> =
  | { readonly status: 'succeeded'; readonly value: TValue }
  | { readonly status: 'failed'; readonly error: ClaimError };

/**
 * A replayable failure. `code` is a CLOSED host vocabulary, never a raw vendor
 * string — this value is persisted and returned to callers.
 */
export interface ClaimError {
  readonly code: string;
  readonly message: string;
  /** The status the original failure carried, so a replay answers exactly as the first attempt did. */
  readonly status?: number;
}

/**
 * The composite identity of a claim.
 *
 * `key` alone is not the identity. Two different operations must never share a
 * key, and a key issued for one aggregate/actor must not satisfy a command
 * against another — so the operation and any scoping segments are part of what
 * the unique index covers. `@classytic/cart` learned this as
 * `(organizationId, cartRef, operation, actorRef, idempotencyKey)`.
 */
export interface IdempotencyIdentity {
  /** The command this key was issued for — `'checkout.finalize'`, `'purchase.pay'`. */
  readonly operation: string;
  /** Caller-supplied key, stable across retries of the SAME logical command. */
  readonly key: string;
  /** Scoping segments — organizationId, aggregate ref, actor ref. */
  readonly scope?: Readonly<Record<string, string>>;
}

/**
 * A claim record. The adapter persists exactly these fields (plus whatever it
 * needs for TTL), with a unique index over {@link IdempotencyIdentity}.
 */
export interface IdempotencyClaim<TValue = unknown> {
  readonly identity: IdempotencyIdentity;
  /**
   * Digest of the request body this key was first used with. A retry that
   * presents the same key with a DIFFERENT body is not a retry — see
   * {@link decideClaim}.
   */
  readonly requestFingerprint: string;
  readonly state: ClaimState;
  /** Which ATTEMPT currently owns the claim. Rotates on takeover. */
  readonly leaseToken: string;
  /** After this instant the lease is dead and another attempt may take over. */
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
  /** Set when `state` becomes terminal. */
  readonly completedAt?: Date;
  /** Present iff `state` is terminal. Absent on `in_flight`. */
  readonly result?: ClaimResult<TValue>;
  /** Monotonic attempt counter — each successful takeover increments it. */
  readonly attempts: number;
  /**
   * RECOVERY POINT — what an attempt has durably done so far (`{ orderNumber }` once the
   * order is persisted). Carried across a takeover so the next attempt RESUMES from it
   * instead of repeating a side effect that already landed.
   */
  readonly progress?: Readonly<Record<string, unknown>>;
  /**
   * What the command was asked to do (`{ orderNumber, amount }`) — written on the FIRST claim
   * and never changed, so a recovery sweep can re-drive a lapsed claim from the store alone.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /** The last AMBIGUOUS failure — for the sweep and for an operator reading a stuck claim. */
  readonly lastError?: string;
}

export type IdempotencyErrorCode =
  /** Same key, different request body. Never a retry — two commands sharing one key. */
  | 'FINGERPRINT_MISMATCH'
  /** A terminal claim carrying no stored result. Unreplayable; must not answer "ok". */
  | 'MISSING_REPLAY'
  /** The attempt no longer owns the lease — another attempt took over. */
  | 'LEASE_LOST'
  /** Completing / renewing a claim that already reached a terminal state. */
  | 'ALREADY_TERMINAL'
  /** Malformed input (empty key, non-positive lease, invalid instant). */
  | 'INVALID_CLAIM'
  /** A body nested past {@link MAX_FINGERPRINT_DEPTH} — refused, never truncated or recursed. */
  | 'UNFINGERPRINTABLE';

export class IdempotencyError extends Error {
  override readonly name = 'IdempotencyError';
  readonly code: IdempotencyErrorCode;

  constructor(code: IdempotencyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Identity + fingerprint
// ─────────────────────────────────────────────────────────────────────────

/**
 * The deterministic string form of an identity — the unique key a store indexes.
 *
 * JSON of `[operation, key, [[scopeKey, value], …]]` with scope keys in CODE-POINT order.
 * Never a delimiter join (`{ ref: 'a:b' }` and `{ ref: 'a', x: 'b' }` would collide) and
 * never a locale-aware sort: a key that moves when a server's locale changes lets a retry miss
 * its claim and execute again.
 */
export function identityKey(identity: IdempotencyIdentity): string {
  assertNonEmpty(identity.operation, 'identity.operation');
  assertNonEmpty(identity.key, 'identity.key');
  const scope = identity.scope ?? {};
  const pairs = Object.keys(scope)
    .sort()
    .map((k) => [k, scope[k]]);
  return JSON.stringify([identity.operation, identity.key, pairs]);
}

/** True when two identities address the same claim. */
export function sameIdentity(a: IdempotencyIdentity, b: IdempotencyIdentity): boolean {
  return identityKey(a) === identityKey(b);
}

/**
 * Fingerprint a request body — the canonical digest of what the WIRE carries.
 *
 * Key-order independent, and wire-equivalent: an `undefined` property is absent, a `Date`
 * is its ISO string, an object is its `toJSON` — so a body a caller built in memory
 * fingerprints like the same body received over HTTP. Use the WHOLE body that decides the
 * mutation; a subset lets two different commands share a fingerprint.
 *
 * Throws `UNFINGERPRINTABLE` past {@link MAX_FINGERPRINT_DEPTH} levels — refuse that body.
 */
export function fingerprintRequest(body: unknown): string {
  return contentHash(toWire(body === undefined ? null : body, 0));
}

/** JSON's projection (`undefined` dropped / `null` in arrays, `toJSON` honoured), depth-bounded. */
function toWire(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_FINGERPRINT_DEPTH) {
    throw new IdempotencyError(
      'UNFINGERPRINTABLE',
      `request body nested deeper than ${MAX_FINGERPRINT_DEPTH} levels`,
    );
  }
  const json = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof json === 'function') return toWire(json.call(value), depth);
  if (Array.isArray(value))
    return value.map((v) => (v === undefined ? null : toWire(v, depth + 1)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toWire(v, depth + 1);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Lease
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mint a lease token for ONE attempt.
 *
 * Random on purpose — see the module docblock. This is the one identifier in
 * the idempotency contract that must NOT be derived.
 */
export function newLeaseToken(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Has the crash-window lease lapsed at `now`? Expiry is exclusive of `now`. */
export function isLeaseExpired(claim: IdempotencyClaim<unknown>, now: Date): boolean {
  return now.getTime() >= claim.leaseExpiresAt.getTime();
}

/** Does `leaseToken` still own this claim at `now`? */
export function holdsLease(
  claim: IdempotencyClaim<unknown>,
  leaseToken: string,
  now: Date,
): boolean {
  return claim.leaseToken === leaseToken && !isLeaseExpired(claim, now);
}

// ─────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────

export interface ClaimRequest {
  readonly identity: IdempotencyIdentity;
  readonly requestFingerprint: string;
  /** Injected clock — no ambient `new Date()`, so the crash window is testable. */
  readonly now: Date;
  /** Injected token for THIS attempt — see {@link newLeaseToken}. */
  readonly leaseToken: string;
  /** Crash-window length. Default {@link DEFAULT_LEASE_MS}. */
  readonly leaseMs?: number;
  /** Stored on a FRESH claim only — see {@link IdempotencyClaim.context}. */
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Takeover ceiling. A lapsed claim that already ran this many attempts is `exhausted`
   * instead of taken over — a command whose side effect keeps failing ambiguously needs a
   * person, not a sixth automatic try. Absent = unbounded.
   */
  readonly maxAttempts?: number;
}

/** This attempt owns the claim and must EXECUTE the command. */
export interface ClaimedDecision<TValue> {
  readonly outcome: 'claimed';
  readonly claim: IdempotencyClaim<TValue>;
  /**
   * Present when this claim took over a lapsed lease — the dead attempt's
   * token. Persist the takeover as a CONDITIONAL update on that token so two
   * simultaneous takeovers cannot both win.
   */
  readonly tookOverFrom?: string;
}

/** A terminal record exists: RETURN its result, execute nothing. */
export interface ReplayedDecision<TValue> {
  readonly outcome: 'replayed';
  readonly claim: IdempotencyClaim<TValue>;
  readonly result: ClaimResult<TValue>;
}

/**
 * Another attempt holds a live lease. **Not a failure** — the answer is not yet
 * known. Wait `retryAfterMs` and re-ask; never re-execute.
 */
export interface InFlightDecision<TValue> {
  readonly outcome: 'in_flight';
  readonly claim: IdempotencyClaim<TValue>;
  /** How long until the incumbent's lease lapses. Always > 0. */
  readonly retryAfterMs: number;
}

/** A lapsed claim reached `maxAttempts`. Nothing executes — escalate it to a person. */
export interface ExhaustedDecision<TValue> {
  readonly outcome: 'exhausted';
  readonly claim: IdempotencyClaim<TValue>;
}

export type ClaimDecision<TValue = unknown> =
  | ClaimedDecision<TValue>
  | ReplayedDecision<TValue>
  | InFlightDecision<TValue>
  | ExhaustedDecision<TValue>;

/**
 * The whole state machine, as one pure function.
 *
 * | stored state | lease | decision |
 * |---|---|---|
 * | (none) | — | `claimed` — fresh claim |
 * | `in_flight` | live | `in_flight` — wait, do NOT execute |
 * | `in_flight` | lapsed | `claimed` — takeover, `tookOverFrom` set |
 * | `in_flight` | lapsed, `attempts ≥ maxAttempts` | `exhausted` — escalate, do NOT execute |
 * | `succeeded` / `failed` | — | `replayed` — return the stored result |
 *
 * Two conditions throw rather than returning a decision, because both mean the
 * question itself was wrong:
 *
 * - **`FINGERPRINT_MISMATCH`** — the same key with a different body. That is
 *   two commands, not one retried command; answering either way is wrong.
 *   Surface it as a 4xx (Stripe returns 400 here), never as a fresh claim.
 * - **`MISSING_REPLAY`** — a terminal record with no stored result. There is
 *   nothing to replay, and inventing an empty success is precisely the silent
 *   permissive default this codebase keeps getting bitten by.
 */
export function decideClaim<TValue = unknown>(
  existing: IdempotencyClaim<TValue> | null | undefined,
  request: ClaimRequest,
): ClaimDecision<TValue> {
  assertNonEmpty(request.requestFingerprint, 'request.requestFingerprint');
  assertNonEmpty(request.leaseToken, 'request.leaseToken');
  assertInstant(request.now, 'request.now');
  const leaseMs = request.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new IdempotencyError(
      'INVALID_CLAIM',
      `leaseMs must be a positive number of milliseconds, got ${String(request.leaseMs)} — ` +
        'a zero or negative lease is instantly expired, so every concurrent attempt takes over and executes.',
    );
  }

  if (existing == null) {
    return { outcome: 'claimed', claim: mintClaim<TValue>(request, leaseMs, 1) };
  }

  if (existing.requestFingerprint !== request.requestFingerprint) {
    throw new IdempotencyError(
      'FINGERPRINT_MISMATCH',
      `Idempotency key '${existing.identity.key}' was first used with a different request body ` +
        `(stored ${existing.requestFingerprint.slice(0, 12)}…, presented ${request.requestFingerprint.slice(0, 12)}…). ` +
        'Two distinct commands are sharing one key — replaying the first would return the wrong result, and claiming afresh would apply the second under a key already spent.',
    );
  }

  if (existing.state === 'succeeded' || existing.state === 'failed') {
    if (existing.result === undefined) {
      throw new IdempotencyError(
        'MISSING_REPLAY',
        `Claim '${existing.identity.key}' is terminal (${existing.state}) but stores no result, so the retry cannot be answered. ` +
          'Reporting success here would fabricate an outcome that was never observed.',
      );
    }
    return { outcome: 'replayed', claim: existing, result: existing.result };
  }

  if (!isLeaseExpired(existing, request.now)) {
    return {
      outcome: 'in_flight',
      claim: existing,
      retryAfterMs: existing.leaseExpiresAt.getTime() - request.now.getTime(),
    };
  }

  if (request.maxAttempts !== undefined && existing.attempts >= request.maxAttempts) {
    return { outcome: 'exhausted', claim: existing };
  }

  return {
    outcome: 'claimed',
    claim: {
      ...mintClaim<TValue>(withoutContext(request), leaseMs, existing.attempts + 1),
      createdAt: existing.createdAt,
      ...(existing.progress !== undefined ? { progress: existing.progress } : {}),
      ...(existing.context !== undefined ? { context: existing.context } : {}),
      ...(existing.lastError !== undefined ? { lastError: existing.lastError } : {}),
    },
    tookOverFrom: existing.leaseToken,
  };
}

/** A takeover keeps the FIRST attempt's context, so the new request's is dropped. */
function withoutContext(request: ClaimRequest): ClaimRequest {
  const { context: _ignored, ...rest } = request;
  return rest;
}

function mintClaim<TValue>(
  request: ClaimRequest,
  leaseMs: number,
  attempts: number,
): IdempotencyClaim<TValue> {
  identityKey(request.identity); // validates operation + key are non-empty
  return {
    identity: request.identity,
    requestFingerprint: request.requestFingerprint,
    state: 'in_flight',
    leaseToken: request.leaseToken,
    leaseExpiresAt: new Date(request.now.getTime() + leaseMs),
    createdAt: request.now,
    ...(request.context !== undefined ? { context: request.context } : {}),
    attempts,
  };
}

/**
 * Extend a live lease — for a command that legitimately outruns the crash
 * window. Throws `LEASE_LOST` when the caller no longer owns the claim, so a
 * superseded attempt cannot silently keep working and then write its result
 * over the winner's.
 */
export function renewLease<TValue>(
  claim: IdempotencyClaim<TValue>,
  input: { readonly leaseToken: string; readonly now: Date; readonly leaseMs?: number },
): IdempotencyClaim<TValue> {
  assertInstant(input.now, 'now');
  if (claim.state !== 'in_flight') {
    throw new IdempotencyError('ALREADY_TERMINAL', `cannot renew a ${claim.state} claim`);
  }
  if (!holdsLease(claim, input.leaseToken, input.now)) {
    throw new IdempotencyError(
      'LEASE_LOST',
      `lease token does not own this claim at ${input.now.toISOString()} (expired or taken over) — ` +
        'continuing would let two attempts believe they are the live one.',
    );
  }
  return {
    ...claim,
    leaseExpiresAt: new Date(input.now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS)),
  };
}

/**
 * Move a claim to a terminal state with the result retries will replay.
 *
 * The lease check is the important part: an attempt whose lease lapsed and was
 * taken over must NOT write its result. Without it, the slow attempt's answer
 * overwrites the takeover's, and every subsequent retry replays an outcome that
 * does not match what was actually applied.
 */
export function completeClaim<TValue>(
  claim: IdempotencyClaim<TValue>,
  input: {
    readonly leaseToken: string;
    readonly now: Date;
    readonly result: ClaimResult<TValue>;
  },
): IdempotencyClaim<TValue> {
  assertInstant(input.now, 'now');
  if (claim.state !== 'in_flight') {
    throw new IdempotencyError(
      'ALREADY_TERMINAL',
      `claim is already ${claim.state}; completing it again would replace a result that retries may already have replayed.`,
    );
  }
  if (claim.leaseToken !== input.leaseToken) {
    throw new IdempotencyError(
      'LEASE_LOST',
      'lease token does not own this claim — another attempt took it over, and writing this result would overwrite theirs.',
    );
  }
  return {
    ...claim,
    state: input.result.status,
    result: input.result,
    completedAt: input.now,
  };
}

/**
 * Narrowing helper for the one outcome callers keep getting wrong.
 *
 * `in_flight` is neither success nor failure. Route it to a 409 + `Retry-After`
 * (or an internal wait), never to the command's error path.
 */
export function isInFlight<TValue>(
  decision: ClaimDecision<TValue>,
): decision is InFlightDecision<TValue> {
  return decision.outcome === 'in_flight';
}

// ─────────────────────────────────────────────────────────────────────────
// The store port
// ─────────────────────────────────────────────────────────────────────────

/**
 * Persistence for claims. Every write is ATOMIC on one identity — the whole
 * correctness of {@link runIdempotent} rests on these compare-and-set
 * operations, so an adapter must not emulate them with read-then-write.
 *
 * An adapter proves itself with `@classytic/primitives/testing/idempotency-store`.
 * Retention (how long a terminal claim is kept) is the adapter's configuration;
 * size it to the longest a caller may retry — days for an offline till.
 */
export interface IdempotencyClaimStore {
  /** The claim for `identity`, or `null`. */
  get<TValue>(
    identity: IdempotencyIdentity,
    options?: IdempotencyStoreCallOptions,
  ): Promise<IdempotencyClaim<TValue> | null>;
  /** Insert iff no claim exists for its identity. `false` = another attempt got there first. */
  insert<TValue>(
    claim: IdempotencyClaim<TValue>,
    options?: IdempotencyStoreCallOptions,
  ): Promise<boolean>;
  /**
   * Replace the claim iff it is `in_flight` AND holds `expectedLeaseToken`.
   * Used for takeover, checkpoint, lapse and completion. `false` = the lease moved on.
   */
  swap<TValue>(
    identity: IdempotencyIdentity,
    expectedLeaseToken: string,
    next: IdempotencyClaim<TValue>,
    options?: IdempotencyStoreCallOptions,
  ): Promise<boolean>;
  /**
   * Delete the claim iff it is `in_flight` AND holds `expectedLeaseToken` — frees
   * the key after a TRANSIENT failure so a retry may execute. `false` = not ours.
   */
  release(
    identity: IdempotencyIdentity,
    expectedLeaseToken: string,
    options?: IdempotencyStoreCallOptions,
  ): Promise<boolean>;
  /**
   * In-flight claims of `operation` whose lease lapsed by `now`, oldest lease first — what a
   * recovery sweep re-drives (each through `runIdempotent` with the claim's own identity and
   * fingerprint, so the takeover is atomic and resumes from the stored progress).
   */
  listLapsed(operation: string, now: Date, limit: number): Promise<IdempotencyClaim<unknown>[]>;
}

/**
 * Per-call options a store honours. `session` is the caller's open transaction: when the
 * command's writes are transactional, pass it so the claim COMMITS OR ROLLS BACK WITH THEM —
 * a claim committed beside a rolled-back write replays a result that does not exist.
 */
export interface IdempotencyStoreCallOptions {
  readonly session?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// The runner
// ─────────────────────────────────────────────────────────────────────────

/**
 * A replay of a command that failed TERMINALLY — the same answer the first
 * attempt got. `code` / `status` are the stored {@link ClaimError}.
 */
export class IdempotentReplayError extends Error {
  override readonly name = 'IdempotentReplayError';
  readonly code: string;
  readonly status?: number;

  constructor(error: ClaimError) {
    super(error.message);
    this.code = error.code;
    if (error.status !== undefined) this.status = error.status;
  }
}

/**
 * What a failure of `execute` means for the claim.
 *
 * - `terminal` — the command definitively failed; every retry replays this error.
 * - `transient` — nothing landed; the claim is released and a retry executes afresh.
 * - `ambiguous` — a side effect MAY have landed (a timeout mid external call): the claim is
 *   kept, its lease lapsed NOW and the error recorded, so a retry or sweep takes over at once
 *   and resumes from the recorded progress.
 *
 * A `transient` failure after a checkpoint is treated as `ambiguous`: something did land.
 */
export type FailureDisposition =
  | { readonly kind: 'terminal'; readonly error: ClaimError }
  | { readonly kind: 'transient' }
  | { readonly kind: 'ambiguous' };

export interface RunIdempotentOptions<TValue> {
  readonly store: IdempotencyClaimStore;
  readonly identity: IdempotencyIdentity;
  /** {@link fingerprintRequest} of the WHOLE body that decides the command. */
  readonly requestFingerprint: string;
  /**
   * The command. Runs only when this attempt owns the claim. Its return value is
   * STORED and replayed, so return something serializable and small — a pointer
   * (`{ orderNumber }`) the caller reloads, not the whole aggregate.
   */
  readonly execute: (attempt: IdempotentAttempt) => Promise<TValue>;
  /**
   * What the command was asked to do, stored on the FIRST claim — everything a sweep needs to
   * re-drive it from the store alone. Handed back to `execute` as `attempt.context`.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Takeover ceiling — past it the run is `exhausted`, see {@link ClaimRequest.maxAttempts}. */
  readonly maxAttempts?: number;
  /** Passed to every store call — `{ session }` to claim inside the caller's transaction. */
  readonly storeOptions?: IdempotencyStoreCallOptions;
  /**
   * What a failure means — see {@link FailureDisposition}. Default `transient`: a validation
   * refusal should be classified `terminal`, or each retry re-runs it to the same answer.
   */
  readonly classifyFailure?: (error: unknown) => FailureDisposition;
  /**
   * Crash-window length. MUST exceed the command's worst-case run time: a lease
   * that lapses mid-command lets a retry take over and execute concurrently.
   */
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly newLeaseToken?: () => string;
}

/** What `execute` is handed: which attempt it is, what it was asked, and how to record a recovery point. */
export interface IdempotentAttempt {
  readonly leaseToken: string;
  /** 1 for the first attempt; higher after a takeover of a crashed one. */
  readonly attempt: number;
  /** The recovery point a crashed attempt reached — RESUME from it, do not repeat it. */
  readonly progress: Readonly<Record<string, unknown>> | undefined;
  /** The stored context — the FIRST attempt's, on a takeover. */
  readonly context: Readonly<Record<string, unknown>> | undefined;
  /**
   * Durably record a recovery point (merged into the stored progress). Call it right
   * after a side effect that must not be repeated — or INSIDE that side effect's transaction
   * (`{ session }`), so the two commit together and no crash can separate them. Throws
   * `LEASE_LOST` if another attempt took over — stop, the command is no longer yours.
   */
  readonly checkpoint: (
    progress: Readonly<Record<string, unknown>>,
    options?: IdempotencyStoreCallOptions,
  ) => Promise<void>;
}

export type IdempotentRun<TValue> =
  /** This attempt ran the command. */
  | { readonly outcome: 'executed'; readonly value: TValue; readonly attempt: number }
  /** A previous attempt succeeded; its stored value, nothing executed. */
  | { readonly outcome: 'replayed'; readonly value: TValue }
  /**
   * Another attempt is running it. **Not a failure** — answer 409 + `Retry-After`, or wait and
   * re-run. `progress` is what it has durably done so far.
   */
  | {
      readonly outcome: 'in_flight';
      readonly retryAfterMs: number;
      readonly progress: Readonly<Record<string, unknown>> | undefined;
    }
  /** `maxAttempts` spent on a command that keeps failing ambiguously. Nothing ran — escalate. */
  | {
      readonly outcome: 'exhausted';
      readonly attempts: number;
      readonly progress: Readonly<Record<string, unknown>> | undefined;
      readonly lastError: string | undefined;
    };

/** Bounded so a store that never lets an insert or swap win cannot spin forever. */
const MAX_CLAIM_ROUNDS = 5;

/**
 * Run `execute` at most once per identity: claim → execute → complete.
 *
 * - a first attempt, or a takeover of a lapsed lease → executes (a takeover resumes from
 *   the stored progress and context);
 * - a completed success → replays the stored value;
 * - a completed terminal failure → throws {@link IdempotentReplayError};
 * - a live attempt elsewhere → `in_flight`, never an execution;
 * - a lapsed claim past `maxAttempts` → `exhausted`, never an execution;
 * - the same key with a different body → throws `FINGERPRINT_MISMATCH`.
 *
 * A failure of `execute` is rethrown unchanged after the claim is updated per its
 * {@link FailureDisposition}. A completion that finds the lease taken over throws
 * `LEASE_LOST`: the work WAS applied, so saying "ok" would hide that two attempts ran.
 */
export async function runIdempotent<TValue>(
  options: RunIdempotentOptions<TValue>,
): Promise<IdempotentRun<TValue>> {
  const { store, identity, requestFingerprint, storeOptions } = options;
  const now = options.now ?? (() => new Date());
  const mintToken = options.newLeaseToken ?? newLeaseToken;

  let claim: IdempotencyClaim<TValue> | undefined;
  for (let round = 0; round < MAX_CLAIM_ROUNDS && !claim; round++) {
    const existing = await store.get<TValue>(identity, storeOptions);
    const decision = decideClaim<TValue>(existing, {
      identity,
      requestFingerprint,
      now: now(),
      leaseToken: mintToken(),
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    });
    if (decision.outcome === 'in_flight') {
      return {
        outcome: 'in_flight',
        retryAfterMs: decision.retryAfterMs,
        progress: decision.claim.progress,
      };
    }
    if (decision.outcome === 'exhausted') {
      return {
        outcome: 'exhausted',
        attempts: decision.claim.attempts,
        progress: decision.claim.progress,
        lastError: decision.claim.lastError,
      };
    }
    if (decision.outcome === 'replayed') {
      if (decision.result.status === 'failed')
        throw new IdempotentReplayError(decision.result.error);
      return { outcome: 'replayed', value: decision.result.value };
    }
    const won =
      decision.tookOverFrom === undefined
        ? await store.insert(decision.claim, storeOptions)
        : await store.swap(identity, decision.tookOverFrom, decision.claim, storeOptions);
    if (won) claim = decision.claim;
  }
  if (!claim) {
    throw new IdempotencyError(
      'INVALID_CLAIM',
      `could not claim '${identity.key}' in ${MAX_CLAIM_ROUNDS} rounds — the store keeps refusing both insert and swap, which a conforming store cannot do.`,
    );
  }

  const { leaseToken } = claim;
  let current: IdempotencyClaim<TValue> = claim;
  const checkpoint = async (
    progress: Readonly<Record<string, unknown>>,
    callOptions?: IdempotencyStoreCallOptions,
  ): Promise<void> => {
    const next = { ...current, progress: { ...current.progress, ...progress } };
    if (!(await store.swap(identity, leaseToken, next, callOptions ?? storeOptions))) {
      throw new IdempotencyError(
        'LEASE_LOST',
        `'${identity.key}' was taken over by another attempt — stop, the command is no longer this attempt's.`,
      );
    }
    current = next;
  };

  let value: TValue;
  try {
    value = await options.execute({
      leaseToken,
      attempt: claim.attempts,
      progress: claim.progress,
      context: claim.context,
      checkpoint,
    });
  } catch (error) {
    let disposition: FailureDisposition = options.classifyFailure?.(error) ?? { kind: 'transient' };
    if (disposition.kind === 'transient' && current.progress !== undefined)
      disposition = { kind: 'ambiguous' };
    try {
      if (disposition.kind === 'terminal') {
        const failed = completeClaim(current, {
          leaseToken,
          now: now(),
          result: { status: 'failed', error: disposition.error },
        });
        await store.swap(identity, leaseToken, failed, storeOptions);
      } else if (disposition.kind === 'ambiguous') {
        const lapsed = { ...current, leaseExpiresAt: now(), lastError: errorMessage(error) };
        await store.swap(identity, leaseToken, lapsed, storeOptions);
      } else {
        await store.release(identity, leaseToken, storeOptions);
      }
    } catch {
      // The command's own error is the answer; an unrecorded claim lapses with its lease.
    }
    throw error;
  }

  const done = completeClaim(current, {
    leaseToken,
    now: now(),
    result: { status: 'succeeded', value },
  });
  if (!(await store.swap(identity, leaseToken, done, storeOptions))) {
    throw new IdempotencyError(
      'LEASE_LOST',
      `'${identity.key}' executed, but its lease was taken over before it could complete — the command may have run twice. Raise leaseMs above the command's run time.`,
    );
  }
  return { outcome: 'executed', value, attempt: claim.attempts };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdempotencyError(
      'INVALID_CLAIM',
      `${label} must be a non-empty string, got ${String(value)}`,
    );
  }
}

function assertInstant(value: unknown, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new IdempotencyError(
      'INVALID_CLAIM',
      `${label} must be a valid Date, got ${String(value)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The reference store
// ─────────────────────────────────────────────────────────────────────────

/**
 * In-memory {@link IdempotencyClaimStore} — tests, scripts, single-process tools. Not for a
 * server: claims die with the process, so a retry after a restart executes again.
 */
export function createMemoryIdempotencyStore(): IdempotencyClaimStore & {
  /** Every stored claim — for assertions. */
  readonly claims: () => IdempotencyClaim<unknown>[];
} {
  const rows = new Map<string, IdempotencyClaim<unknown>>();
  const ownedInFlight = (identity: IdempotencyIdentity, token: string) => {
    const row = rows.get(identityKey(identity));
    return row !== undefined && row.state === 'in_flight' && row.leaseToken === token;
  };

  return {
    async get<TValue>(identity: IdempotencyIdentity) {
      return (rows.get(identityKey(identity)) as IdempotencyClaim<TValue> | undefined) ?? null;
    },
    async insert(claim) {
      const key = identityKey(claim.identity);
      if (rows.has(key)) return false;
      rows.set(key, claim);
      return true;
    },
    async swap(identity, expectedLeaseToken, next) {
      if (!ownedInFlight(identity, expectedLeaseToken)) return false;
      rows.set(identityKey(identity), next);
      return true;
    },
    async release(identity, expectedLeaseToken) {
      if (!ownedInFlight(identity, expectedLeaseToken)) return false;
      rows.delete(identityKey(identity));
      return true;
    },
    async listLapsed(operation, now, limit) {
      return [...rows.values()]
        .filter(
          (c) =>
            c.identity.operation === operation &&
            c.state === 'in_flight' &&
            c.leaseExpiresAt <= now,
        )
        .sort((a, b) => a.leaseExpiresAt.getTime() - b.leaseExpiresAt.getTime())
        .slice(0, limit);
    },
    claims: () => [...rows.values()],
  };
}
