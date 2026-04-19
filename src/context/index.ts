/**
 * Public entry for the `context` subpath.
 *
 * Consumers import `RepositoryContext` from here. Plugins declare their
 * hook signatures against it; kits mutate it inside the hook chain.
 */

export type { RepositoryContext } from './types.js';
