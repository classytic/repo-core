/**
 * Repository → domain-event bridge.
 *
 * Wired by `RepositoryBase` when construction options carry `events:
 * { transport }`. Registers OBSERVABILITY-priority `after:*` hooks that
 * publish `<resource>.<verb>` events for every mutating operation — the
 * same config-driven activation pattern media-kit established: pass a
 * transport and events light up; omit it and the wiring is inert.
 *
 * Event naming follows the arc resource-lifecycle convention:
 *
 *   create / createMany / getOrCreate(created) → `<resource>.created`
 *   update / findOneAndUpdate / claim / claimVersion / replace / upsert
 *                                              → `<resource>.updated`
 *   delete                                     → `<resource>.deleted`
 *   restore                                    → `<resource>.restored`
 *   updateMany                                 → `<resource>.updatedMany`
 *   deleteMany                                 → `<resource>.deletedMany`
 *
 * Publish failures NEVER fail the operation — they route to the repo's
 * `error:events` hook (subscribe there for alerting) and are otherwise
 * swallowed. Events are at-most-once from the repo's perspective; hosts
 * needing guaranteed delivery use the outbox pattern (session-threaded
 * `before:*` hooks) instead.
 *
 * **WARNING — arc double-publish.** These event names are the SAME ones
 * `@classytic/arc`'s `eventStrategy: 'auto'` emits (`<resource>.created`
 * / `.updated` / `.deleted`). A host wiring BOTH this repo-level bridge
 * AND arc auto events for the same resource publishes every event twice,
 * silently — arc's dual-publish dev-warn only watches its own publish
 * paths and cannot see this layer. Pick ONE layer per resource: the
 * repo-level bridge OR arc's framework-level auto events.
 */

import type { RepositoryContext } from '../context/index.js';
import { HOOK_PRIORITY } from '../hooks/index.js';
import type { RepositoryBase } from '../repository/base.js';
import type { DomainEvent, EventMeta, RepositoryEventPublisher } from './types.js';

/** Construction-time event wiring. */
export interface RepositoryEventsOptions {
  /** Any arc / primitives-compatible transport. Only `publish` is consumed. */
  transport: RepositoryEventPublisher;
  /**
   * Event-name prefix. Defaults to the repository's model name lowercased
   * (`User` model → `user.created`).
   */
  resource?: string;
  /** `meta.source` — originating service/package (`'commerce'`, `'billing'`). */
  source?: string;
  /** Static meta merged into every event (host-controlled overrides win). */
  meta?: Partial<EventMeta>;
}

const CREATED_OPS = ['create'] as const;
const UPDATED_OPS = [
  'update',
  'findOneAndUpdate',
  'claim',
  'claimVersion',
  'replace',
  'upsert',
] as const;

function eventId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Platform-neutral fallback (no crypto global — exotic embedded runtimes).
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pull actor/tenant/correlation meta off the hook context (and its options bag). */
function contextMeta(context: RepositoryContext): Partial<EventMeta> {
  const options = asRecord(context['options']) ?? {};
  const pick = (key: string): unknown => options[key] ?? context[key];
  const meta: Partial<EventMeta> = {};
  const userId = pick('userId');
  if (typeof userId === 'string') meta.userId = userId;
  const organizationId = pick('organizationId');
  if (typeof organizationId === 'string') meta.organizationId = organizationId;
  const requestId = pick('requestId');
  if (typeof requestId === 'string') meta.correlationId = requestId;
  return meta;
}

function resourceId(result: unknown, context: RepositoryContext): string | undefined {
  const doc = asRecord(result);
  const raw = doc?.['_id'] ?? doc?.['id'] ?? context.id;
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** Install the after-hooks. Called by `RepositoryBase`; not host-facing. */
export function registerRepositoryEvents(
  repo: RepositoryBase,
  options: RepositoryEventsOptions,
): void {
  const resource = options.resource ?? repo.modelName.toLowerCase();
  const transport = options.transport;

  const buildEvent = (
    verb: string,
    payload: unknown,
    context: RepositoryContext,
    id: string | undefined,
  ): DomainEvent => ({
    type: `${resource}.${verb}`,
    payload,
    meta: {
      id: eventId(),
      timestamp: new Date(),
      resource,
      ...(id !== undefined ? { resourceId: id, partitionKey: id } : {}),
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...contextMeta(context),
      ...options.meta,
    },
  });

  const publish = async (event: DomainEvent): Promise<void> => {
    try {
      await transport.publish(event);
    } catch (err) {
      // Publishing must never fail the operation. Route to error:events
      // for hosts that alert on transport failures.
      repo.emit('error:events', { event, error: err });
    }
  };

  const onResult =
    (verb: string) =>
    async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
      if (result === null || result === undefined) return; // miss / race-loss — nothing happened
      await publish(buildEvent(verb, result, context, resourceId(result, context)));
    };

  const observe = { priority: HOOK_PRIORITY.OBSERVABILITY };

  for (const op of CREATED_OPS) repo.on(`after:${op}`, onResult('created'), observe);
  for (const op of UPDATED_OPS) repo.on(`after:${op}`, onResult('updated'), observe);
  repo.on(`after:restore`, onResult('restored'), observe);

  repo.on(
    'after:delete',
    async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
      if (result === null || result === undefined) return;
      const id = context.id === undefined || context.id === null ? undefined : String(context.id);
      await publish(buildEvent('deleted', id !== undefined ? { id } : result, context, id));
    },
    observe,
  );

  repo.on(
    'after:getOrCreate',
    async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
      const envelope = asRecord(result);
      if (!envelope || envelope['created'] !== true) return; // lookup hit — nothing was written
      const doc = envelope['doc'];
      await publish(buildEvent('created', doc, context, resourceId(doc, context)));
    },
    observe,
  );

  repo.on(
    'after:createMany',
    async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
      if (!Array.isArray(result) || result.length === 0) return;
      const events = result.map((doc) =>
        buildEvent('created', doc, context, resourceId(doc, context)),
      );
      try {
        if (transport.publishMany) {
          await transport.publishMany(events);
        } else {
          for (const event of events) await transport.publish(event);
        }
      } catch (err) {
        repo.emit('error:events', { event: events[0], error: err });
      }
    },
    observe,
  );

  for (const [op, verb] of [
    ['updateMany', 'updatedMany'],
    ['deleteMany', 'deletedMany'],
  ] as const) {
    repo.on(
      `after:${op}`,
      async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        await publish(buildEvent(verb, result, context, undefined));
      },
      observe,
    );
  }
}
