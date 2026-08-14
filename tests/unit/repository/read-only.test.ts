/**
 * `asReadOnlyRepo` — sealing a repository whose rows another writer owns.
 *
 * The failure being prevented: a "read-side overlay" over Better Auth's
 * identity collections that is, in fact, a fully mutable repository. One
 * `defineResource({ routes: ['create'] })` away from writing a user row
 * Better Auth never hashed, cascaded, or hooked.
 *
 * Pinned:
 *   1. Reads pass through, bound to the original.
 *   2. Writes throw — INCLUDING kit-contributed methods this file has
 *      never heard of (seal by default, not by enumeration).
 *   3. `capabilities.readOnly` is true so hosts refuse routes at BOOT.
 *   4. Assignment can't smuggle a write back in.
 */

import { describe, expect, it } from 'vitest';
import {
  asReadOnlyRepo,
  isReadOnlyRepo,
  ReadOnlyRepositoryError,
} from '../../../src/repository/index.js';

function fakeRepo() {
  return {
    idField: '_id',
    capabilities: { transactions: true, nestedTransactions: false, upsert: true },
    rows: [{ _id: 'u1', name: 'ada' }],
    async getById(id: string) {
      return this.rows.find((r) => r._id === id) ?? null;
    },
    async findAll() {
      return this.rows;
    },
    async count() {
      return this.rows.length;
    },
    async create(doc: { _id: string; name: string }) {
      this.rows.push(doc);
      return doc;
    },
    async update(id: string, patch: { name: string }) {
      const row = this.rows.find((r) => r._id === id);
      if (row) row.name = patch.name;
      return row ?? null;
    },
    async delete() {
      this.rows = [];
      return { deletedCount: 1 };
    },
    // A kit-contributed write this module's read list has never seen.
    async claim() {
      return { claimed: true };
    },
  };
}

describe('asReadOnlyRepo', () => {
  it('reads pass through and keep their `this` binding', async () => {
    const sealed = asReadOnlyRepo(fakeRepo(), { reason: 'Better Auth owns writes' });
    await expect(sealed.getById('u1')).resolves.toMatchObject({ name: 'ada' });
    await expect(sealed.findAll()).resolves.toHaveLength(1);
    await expect(sealed.count()).resolves.toBe(1);
    expect(sealed.idField).toBe('_id');
  });

  it('every write throws — and the error names the owner and the alternative', () => {
    const repo = fakeRepo();
    const sealed = asReadOnlyRepo(repo, {
      reason: 'Better Auth owns writes to `user`; mutate via auth.api',
    });

    // Synchronous by design (see the seal's docstring): a forgotten `await`
    // must still crash rather than become a survivable unhandled rejection.
    expect(() => sealed.create({ _id: 'u2', name: 'grace' })).toThrow(ReadOnlyRepositoryError);
    expect(() => sealed.update('u1', { name: 'hacked' })).toThrow(/read-only/);
    expect(() => sealed.delete()).toThrow(/mutate via auth\.api/);

    // Nothing actually happened to the underlying data.
    expect(repo.rows).toEqual([{ _id: 'u1', name: 'ada' }]);
  });

  it('seals a kit method it has never heard of — unknown is refused, not forwarded', () => {
    // The reason the Proxy inverts the default: an enumerated deny-list
    // would leak every method a kit adds after this file was written.
    const sealed = asReadOnlyRepo(fakeRepo(), { reason: 'owned elsewhere' });
    expect(() => sealed.claim()).toThrow(ReadOnlyRepositoryError);
  });

  it('reports capabilities.readOnly so a host can refuse write ROUTES at boot', () => {
    const sealed = asReadOnlyRepo(fakeRepo(), { reason: 'owned elsewhere' });
    expect(sealed.capabilities.readOnly).toBe(true);
    // The rest of the descriptor survives — it is still the same backend.
    expect(sealed.capabilities.transactions).toBe(true);
    expect(isReadOnlyRepo(sealed)).toBe(true);
    expect(isReadOnlyRepo(fakeRepo())).toBe(false);
  });

  it('a write cannot be smuggled in by assignment', () => {
    const sealed = asReadOnlyRepo(fakeRepo(), { reason: 'owned elsewhere' });
    expect(() => {
      (sealed as unknown as { create: unknown }).create = async () => ({ pwned: true });
    }).toThrow(ReadOnlyRepositoryError);
  });
});
