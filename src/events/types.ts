/**
 * Domain-event types — structural mirror of the org-wide event contract.
 *
 * These shapes are structurally compatible with `@classytic/primitives/events`
 * (which itself mirrors `@classytic/arc`'s `EventTransport` verbatim). Repo-core
 * declares only the subset it consumes — `publish` / `publishMany` — so ANY
 * arc transport (memory, Redis, Kafka), primitives' helpers, or media-kit's
 * in-process bus drops into `RepositoryBaseOptions.events.transport` without
 * adapters, and repo-core stays zero-dependency.
 *
 * Width subtyping does the work: a full `EventTransport` (with `subscribe`,
 * `deadLetter`, `close`) satisfies this narrower parameter type automatically.
 */

/**
 * Event metadata. Field semantics mirror arc v2.9 / primitives — see
 * `@classytic/primitives/events` for the exhaustive docs. Repo-core
 * populates `id`, `timestamp`, `resource`, `resourceId`, `source`, and —
 * when present on the call's options bag — `userId`, `organizationId`,
 * `correlationId` (from `requestId`).
 */
export interface EventMeta {
  /** Unique event identifier — UUID v4. */
  id: string;
  /** Emit timestamp. */
  timestamp: Date;
  /** Schema version for this event type. Default: `1`. */
  schemaVersion?: number;
  /** Correlation ID — stable across a causal chain (repo-core forwards `requestId`). */
  correlationId?: string;
  /** Causation ID — `meta.id` of the direct parent event. */
  causationId?: string;
  /** Partition key hint for ordered transports. Defaults to `resourceId`. */
  partitionKey?: string;
  /** Source resource name — the repository's model/table name. */
  resource?: string;
  /** Resource identifier — the document's primary key. */
  resourceId?: string;
  /** User who triggered the event. */
  userId?: string;
  /** Organization / tenant scope. */
  organizationId?: string;
  /** Originating service or package. */
  source?: string;
  /** Idempotency key — stable per logical operation. */
  idempotencyKey?: string;
  /** DDD aggregate marker. */
  aggregate?: { type: string; id: string };
}

/** A domain event — `type` is dotted (`user.created`, `order.updatedMany`). */
export interface DomainEvent<T = unknown> {
  type: string;
  payload: T;
  meta: EventMeta;
}

/** Per-event publish outcome keyed by `meta.id`. `null` = success. */
export type PublishManyResult = ReadonlyMap<string, Error | null>;

/**
 * The transport surface repo-core consumes. Structurally satisfied by any
 * arc / primitives `EventTransport`. Repositories only PUBLISH — subscribing
 * is host territory, on whichever full transport the host wired.
 */
export interface RepositoryEventPublisher {
  readonly name: string;
  publish(event: DomainEvent): Promise<void>;
  /** Batch publish (optional). Used for `createMany` when available. */
  publishMany?(events: readonly DomainEvent[]): Promise<PublishManyResult>;
}
