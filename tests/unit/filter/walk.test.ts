import { describe, expect, it } from 'vitest';
import {
  and,
  collectFields,
  eq,
  type Filter,
  mapFilter,
  not,
  or,
  walkFilter,
} from '../../../src/filter/index.js';

describe('walkFilter', () => {
  it('visits every node in depth-first order', () => {
    const tree = and(eq('a', 1), or(eq('b', 2), not(eq('c', 3))));
    const ops: string[] = [];
    walkFilter(tree, (n) => {
      ops.push(n.op);
    });
    expect(ops).toEqual(['and', 'eq', 'or', 'eq', 'not', 'eq']);
  });

  it('stops descending when visitor returns false', () => {
    const tree = and(eq('a', 1), or(eq('b', 2), eq('c', 3)));
    const visited: string[] = [];
    walkFilter(tree, (n) => {
      visited.push(n.op);
      if (n.op === 'or') return false; // don't descend
    });
    // Saw: and (root), eq (a=1), or (stops before visiting children).
    expect(visited).toEqual(['and', 'eq', 'or']);
  });

  it('collectFields returns every unique field referenced', () => {
    const tree = and(eq('a', 1), or(eq('b', 2), eq('a', 3), not(eq('c', 4))));
    expect(collectFields(tree).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('mapFilter', () => {
  it('post-order applies transform to every node', () => {
    const tree = and(eq('a', 1), eq('b', 2));
    // Rewrite every eq's value to 99.
    const result = mapFilter(tree, (node) =>
      node.op === 'eq' ? { op: 'eq', field: node.field, value: 99 } : node,
    );
    expect(result.op).toBe('and');
    if (result.op === 'and') {
      expect(result.children[0]).toEqual({ op: 'eq', field: 'a', value: 99 });
      expect(result.children[1]).toEqual({ op: 'eq', field: 'b', value: 99 });
    }
  });

  it('identity-preserving — unchanged trees return the same reference', () => {
    const tree = and(eq('a', 1), or(eq('b', 2), eq('c', 3)));
    const result = mapFilter(tree, (node) => node);
    expect(result).toBe(tree);
  });

  it('preserves children that were not rewritten (structural sharing)', () => {
    const unchangedBranch = eq('b', 2);
    const tree = and(eq('a', 1), unchangedBranch);
    const result = mapFilter(tree, (node) =>
      node.op === 'eq' && node.field === 'a' ? { op: 'eq', field: 'a', value: 99 } : node,
    );
    if (result.op === 'and') {
      // Branch we did not rewrite keeps its reference.
      expect(result.children[1]).toBe(unchangedBranch);
    }
  });

  it('scope-injection usage pattern — wrap every tree in tenant scope', () => {
    // Plugin pattern: inject tenantId at the top of any filter.
    const injectTenant =
      (orgId: string) =>
      (filter: Filter): Filter =>
        and(eq('orgId', orgId), filter);
    const userFilter = or(eq('status', 'active'), eq('status', 'pending'));
    const scoped = injectTenant('org_42')(userFilter);
    expect(scoped.op).toBe('and');
    if (scoped.op === 'and') {
      expect(scoped.children[0]).toEqual({ op: 'eq', field: 'orgId', value: 'org_42' });
      expect(scoped.children[1]).toBe(userFilter);
    }
  });
});
