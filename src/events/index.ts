/**
 * Public entry for the `events` subpath — the repository → domain-event
 * bridge. Pass `events: { transport }` at repository construction and
 * every mutating op publishes `<resource>.<verb>` events through any
 * arc / `@classytic/primitives`-compatible transport. See `emit.ts` for
 * the op → verb mapping and delivery semantics.
 */

export { type RepositoryEventsOptions, registerRepositoryEvents } from './emit.js';
export type {
  DomainEvent,
  EventMeta,
  PublishManyResult,
  RepositoryEventPublisher,
} from './types.js';
