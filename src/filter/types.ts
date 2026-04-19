/**
 * Filter IR — driver-agnostic query AST.
 *
 * A `Filter` is a tagged-union tree that every kit knows how to compile
 * to its native syntax. Plugins compose `Filter` nodes via the combinators
 * in `builders.ts` rather than writing `$`-operator objects directly, so
 * policy hooks (multi-tenant scope, soft-delete) work identically against
 * MongoDB, SQLite, Postgres, and Prisma.
 *
 * The IR is intentionally small — it covers the operator surface every
 * SQL and document store supports. Backend-specific operators (Mongo
 * `$geoWithin`, pgvector `<=>`, Postgres JSONB `@>`) stay kit-native and
 * are composed alongside the IR via each kit's escape hatch, not embedded
 * in this type.
 *
 * **Compat invariant:** mongokit's Mongo-shaped filter objects (`$`-keyed
 * records) are NOT `Filter` values. Kits accept both via a passthrough in
 * their compiler — a raw record is treated as pre-compiled and handed to
 * the driver unchanged. See `isFilter` for the runtime guard.
 */

/** Leaf operator on a single field with a scalar-ish value. */
export interface FilterEq {
  readonly op: 'eq';
  readonly field: string;
  readonly value: unknown;
}

export interface FilterNe {
  readonly op: 'ne';
  readonly field: string;
  readonly value: unknown;
}

export interface FilterGt {
  readonly op: 'gt';
  readonly field: string;
  readonly value: unknown;
}

export interface FilterGte {
  readonly op: 'gte';
  readonly field: string;
  readonly value: unknown;
}

export interface FilterLt {
  readonly op: 'lt';
  readonly field: string;
  readonly value: unknown;
}

export interface FilterLte {
  readonly op: 'lte';
  readonly field: string;
  readonly value: unknown;
}

/** Leaf operator on a single field with a set value. */
export interface FilterIn {
  readonly op: 'in';
  readonly field: string;
  readonly values: readonly unknown[];
}

export interface FilterNin {
  readonly op: 'nin';
  readonly field: string;
  readonly values: readonly unknown[];
}

/**
 * Substring / prefix / suffix match with SQL-style `%` wildcards.
 * Kits compile to MongoDB `$regex`, SQL `LIKE`, Prisma `contains`/`startsWith`/`endsWith`.
 * Use `regex` for anchored/character-class patterns when your schema allows.
 */
export interface FilterLike {
  readonly op: 'like';
  readonly field: string;
  readonly pattern: string;
  /** Case sensitivity. Default `'insensitive'` — matches how most UIs expect search. */
  readonly caseSensitivity?: 'sensitive' | 'insensitive';
}

/**
 * Regex match — the most powerful leaf. Not every driver exposes the same
 * regex dialect (Mongo ICU, Postgres POSIX, SQLite PCRE via extension),
 * so kits MAY reject patterns their backend can't compile. Prefer `like`
 * when a substring match suffices.
 */
export interface FilterRegex {
  readonly op: 'regex';
  readonly field: string;
  readonly pattern: string;
  readonly flags?: string;
}

/** Field presence / absence (NULL vs NOT NULL in SQL; `$exists` in Mongo). */
export interface FilterExists {
  readonly op: 'exists';
  readonly field: string;
  readonly exists: boolean;
}

/** Boolean composition nodes — recursive. */
export interface FilterAnd {
  readonly op: 'and';
  readonly children: readonly Filter[];
}

export interface FilterOr {
  readonly op: 'or';
  readonly children: readonly Filter[];
}

export interface FilterNot {
  readonly op: 'not';
  readonly child: Filter;
}

/** Tautology — matches every document. Useful as an identity for `and` reductions. */
export interface FilterTrue {
  readonly op: 'true';
}

/** Contradiction — matches no document. */
export interface FilterFalse {
  readonly op: 'false';
}

/**
 * Driver-native escape hatch. Carries opaque SQL / query fragment + params
 * through to the compiler untouched. Kits compile by inlining the fragment
 * verbatim (and appending the params in order). Use sparingly — the IR
 * advantage is lost inside a `raw` node.
 *
 * Arc's `matchFilter` (in-memory) always returns `false` for `raw` nodes:
 * evaluating arbitrary SQL in JS isn't possible, so a caller who uses raw
 * must either (a) not rely on in-memory matching for that predicate, or
 * (b) provide their own evaluator via the match options surface.
 *
 * @example pgvector cosine similarity
 * ```ts
 * and(eq('userId', ctx.userId), raw('embedding <=> ? < 0.3', [queryEmbedding]))
 * ```
 */
export interface FilterRaw {
  readonly op: 'raw';
  /** Kit-native query fragment. Embedded verbatim by each kit's compiler. */
  readonly sql: string;
  /** Positional params bound at the position of this fragment in the final query. */
  readonly params?: readonly unknown[];
}

/** Root discriminated-union node. Every kit's compiler pattern-matches on `op`. */
export type Filter =
  | FilterEq
  | FilterNe
  | FilterGt
  | FilterGte
  | FilterLt
  | FilterLte
  | FilterIn
  | FilterNin
  | FilterLike
  | FilterRegex
  | FilterExists
  | FilterAnd
  | FilterOr
  | FilterNot
  | FilterTrue
  | FilterFalse
  | FilterRaw;

/** Narrow set of ops for pattern-matching exhaustiveness checks. */
export type FilterOp = Filter['op'];
