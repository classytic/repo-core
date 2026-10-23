# Contracts: envelopes, errors, query grammar

## Page envelopes (`/pagination`)

```
offset:    { method: 'offset',    data, page, limit, total, pages, hasNext, hasPrev }
keyset:    { method: 'keyset',    data, limit, hasMore, next, prev?, hasPrev?, end? }
aggregate: { method: 'aggregate', data, ... }   // page or keyset shaped, from aggregatePaginate
bare:      { data }                              // BareListResult, from a non-paged list
```

`OffsetPaginationResult<T, TExtra>` and `KeysetPaginationResult<T, TExtra>` take a typed extras bag (a kit may add `warning`). `PaginatedResult<T>` is the
wire union; discriminate with `'method' in res`. `prev`, `hasPrev`, `end` are optional: absent means the kit does not answer, not "none".
`end` is the cursor at the page's last row even when `next` is null (resume a change feed from it).

`toCanonicalList(x)` copies a paged result or wraps a bare array. Call it once at the HTTP edge; clients type responses as `PaginatedResult<T>`.

Cursors: `encodeCursor`, `decodeCursor`, `validateCursorSort`, `validateCursorVersion` (kit authors). Offset math: `calculateSkip`, `calculateTotalPages`,
`validateLimit`, `validatePage`. `mergeKeysetPages(sources, sort, { limit, cursor, secret })` returns one page with ONE composite cursor bound to the
source names, scopes and sort (HMAC-signed when `secret` is set); it returns `{ docs, next, hasNext }`.

## Errors (`/errors`)

Throwable `HttpError`: `status`, optional `code`, `meta`, `validationErrors[]` (`validator`, `error`, `path`), `duplicate` (`fields`, `values?`).
Wire `ErrorContract`: `{ code, message, status?, details?: ErrorDetail[], correlationId?, meta? }`, flat, no `{ error: {} }` wrapper.
`toErrorContract(err)` maps `validationErrors` and `duplicate.fields` to `details` (`path`, `code`, `message`); `status` without `code` derives the code
through `statusToErrorCode`.

| Family | Examples | Source |
|---|---|---|
| cross-cutting | `validation_error`, `not_found`, `conflict`, `unauthorized`, `forbidden`, `rate_limited`, `idempotency_conflict`, `precondition_failed`, `internal_error`, `service_unavailable`, `timeout` | `ERROR_CODES` |
| arc | `arc.conflict`, `arc.validation_error`, `arc.idempotency_key_reused`, `arc.org.access_denied`, `arc.pagination.invalid_mode` | `ARC_ERROR_CODES` |
| reasons | `ORG_CONTEXT_REQUIRED`, `MIXED_UPDATE_SHAPE`, `ALL_FIELDS_STRIPPED` | `ARC_REASON_CODES` |
| cursors | `repo.cursor.invalid`, `repo.cursor.scope_mismatch` | `CURSOR_ERROR_CODES` |
| domain | `order.already_paid` | your package, dotted lowercase |

A duplicate key can surface as `conflict` (thrown by a kit) or `arc.conflict` (raised by the HTTP layer); clients treat both as a 409. Validate a
contract body in tests with `errorContractSchema` and `errorDetailSchema`. Hosts that accept unmapped library errors (auth providers, framework 404s) normalize
them into the contract at the edge.

`conservativeMongoIsDuplicateKey` and `conservativeMongoIsTransientConflict` classify raw driver errors when you have no kit repository to ask.

## Query grammar (`/query-parser`)

`parseUrl(input, options)` accepts `URLSearchParams`, an iterable of pairs, or a record. Result: `{ filter, limit, sort?, select?, populate?, page?, after?, search? }`.

| URL | Meaning |
|---|---|
| `status=active` | equals; repeated keys mean in |
| `age[gte]=18&age[lt]=65` | range |
| `role[in]=a,b`, `role[nin]=a` | membership |
| `name[contains]=jo`, `[startsWith]`, `[endsWith]`, `[ieq]` | literal, case-insensitive text |
| `price[between]=10,100` | inclusive range |
| `deletedAt[exists]=false` | null or missing |
| `title[regex]=^a&title[options]=i` | regex, checked for ReDoS |
| `sort=-createdAt,name`, `select=a,b,-c` | sort and projection |
| `page=2&limit=50`, `after=<cursor>`, `before=<cursor>`, `mode=keyset` | paging (reserved) |

Client side, `formatQuery({ filters: [{ field, op?, value }], sort, page, limit, search })` emits exactly these params (`stringifyQuery` gives the string). `between: [from, to]` is sent as `gte` + `lte`; `in`/`nin` take arrays; empty values are omitted; unrepresentable values throw `QueryGrammarError`.

Options: `allowedFilterFields`, `allowedOperators`, `allowedSortFields`, `fieldTypes` (`boolean`, `date`, `number`...), `defaultLimit` (20), `maxLimit` (1000),
`maxSearchLength` (200), `maxRegexLength`. Every allow-list refuses with a `QueryGrammarError` (400, `INVALID_QUERY_INPUT`); nothing is silently dropped, nothing truncated.
Repeated control params are refused. Lower-level readers: `readFilterClauses`, `readPageRequest`, `readSort`, `readSelect`, `clausesToFilter`.

## Filter IR (`/filter`)

Builders: `eq ne gt gte lt lte in_ nin exists contains startsWith endsWith iEq like regex between isNull isNotNull and or not anyOf noneOf raw TRUE FALSE`.
`and()` with no children is `TRUE`. `recordToFilter(record)` converts a flat record. `walkFilter`, `mapFilter`, `collectFields` traverse; `coerceFilterDates` turns ISO strings
into dates. `matchFilter(filter, row)` evaluates in memory (policy checks, tests). `raw(sql, params)` is SQL-kit only.
