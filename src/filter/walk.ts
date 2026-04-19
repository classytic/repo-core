/**
 * Filter tree traversal + transformation.
 *
 * Plugins use `mapFilter` to inject a scope node (`and(existing, eq('orgId',
 * ctx.orgId))` for multi-tenant, `and(existing, eq('deletedAt', null))` for
 * soft-delete). Because the IR is immutable, all edits return a new tree;
 * identity-preserving when a branch has no changes.
 */

import type { Filter } from './types.js';

/**
 * Depth-first visit of every node. Visitor returns `false` to stop descent
 * into the current subtree (e.g. optimization prunes). Otherwise visits
 * children.
 */
export function walkFilter(filter: Filter, visit: (node: Filter) => boolean | undefined): void {
  const cont = visit(filter);
  if (cont === false) return;

  switch (filter.op) {
    case 'and':
    case 'or':
      for (const child of filter.children) walkFilter(child, visit);
      return;
    case 'not':
      walkFilter(filter.child, visit);
      return;
    default:
      return;
  }
}

/**
 * Post-order transform. `transform` sees every node after its children have
 * been rewritten, so leaf rewrites cascade up. Return the same node
 * reference to opt-out of a rewrite at that level.
 *
 * Guarantees:
 * - Immutable — never mutates input.
 * - Identity-preserving — when no child changes, the parent node is
 *   returned unchanged (useful for structural sharing in caches).
 */
export function mapFilter(filter: Filter, transform: (node: Filter) => Filter): Filter {
  switch (filter.op) {
    case 'and': {
      let changed = false;
      const next: Filter[] = [];
      for (const child of filter.children) {
        const mapped = mapFilter(child, transform);
        if (mapped !== child) changed = true;
        next.push(mapped);
      }
      const rebuilt = changed
        ? Object.freeze({ op: 'and', children: Object.freeze(next) })
        : filter;
      return transform(rebuilt);
    }
    case 'or': {
      let changed = false;
      const next: Filter[] = [];
      for (const child of filter.children) {
        const mapped = mapFilter(child, transform);
        if (mapped !== child) changed = true;
        next.push(mapped);
      }
      const rebuilt = changed ? Object.freeze({ op: 'or', children: Object.freeze(next) }) : filter;
      return transform(rebuilt);
    }
    case 'not': {
      const mapped = mapFilter(filter.child, transform);
      const rebuilt =
        mapped === filter.child ? filter : Object.freeze({ op: 'not', child: mapped });
      return transform(rebuilt);
    }
    // Leaf ops (including `raw` which has no children to traverse):
    default:
      return transform(filter);
  }
}

/** Collect every field name referenced in the tree. Useful for index hints, policy checks. */
export function collectFields(filter: Filter): string[] {
  const seen = new Set<string>();
  walkFilter(filter, (node) => {
    if ('field' in node && typeof node.field === 'string') {
      seen.add(node.field);
    }
  });
  return [...seen];
}
