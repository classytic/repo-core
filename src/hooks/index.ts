/**
 * Public entry for the `hooks` subpath.
 *
 * Consumers must import from `@classytic/repo-core/hooks` rather than
 * a deeper path — the deeper module tree is an implementation detail and
 * may be restructured between minor versions.
 *
 * This file re-exports only its own subpath's symbols. It does NOT
 * re-export from sibling subpaths (`filter`, `operations`, ...) — that
 * would be a root barrel in disguise and defeat tree-shaking.
 */
export { DEFAULT_LISTENER_PRIORITY, HookEngine } from './engine.js';
export { HOOK_EVENTS, type HookEventName } from './events.js';
export { HOOK_PRIORITY, type HookPriority } from './priority.js';
export type { EventPhase, HookListener, HookMode, PrioritizedHook } from './types.js';
