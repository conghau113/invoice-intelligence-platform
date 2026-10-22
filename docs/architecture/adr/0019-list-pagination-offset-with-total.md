# ADR 0019: List pagination: page/limit with a total for lists people read, cursors for append-only streams

- Status: Accepted
- Date: 2026-10-22
- Related tasks: T2.6, T6.3, T6.4

## Context
T2.6 first shipped `GET /documents` with cursor pagination (`API.md` Conventions). Users who review the list want to see how many documents there are, how many pages, and to jump to any page (PRD section 4 lists "pagination" for `/documents`). A cursor knows only "the page after this row": it cannot give a total, a page count or a jump. The same convention would be copied by the next lists (members, notifications, history, approved invoices).

## Options considered
1. Cursor pagination everywhere (the first T2.6 design)
2. `page`/`limit` with `total` and `totalPages` for lists
3. Both on the same endpoint
4. Cursor plus an estimated total

## Decision criteria
- Does it give users total, page count and jump-to-page
- Stability while rows are added (polling, uploads)
- Cost at the data sizes of this project (one tenant: thousands of documents, not millions)
- Code and tests to maintain

## Decision
Option 2 for every list a person reads in the UI: `?page=1&limit=20` (`page` from 1, at most 10 000; `limit` 1 to 100, default 20) answers `{ items, meta: { page, limit, total, totalPages } }`.
- `total` is counted after the tenant (RLS) and the filters, in the same transaction, so it never reveals rows the caller cannot see. A `page` beyond `totalPages` answers empty `items` with the true `meta`; the UI moves to the last page.
- Every sort ends with the tie-breaker `id`, so a page is deterministic.
- Cursor pagination stays for append-only or very large streams (audit log, event replay, job queues) where a total is not wanted. None exists yet; the first one gets its own cursor code then.
- Caches (T6.3) key on tenant, filters, `page` and `limit`; `total` is cached with the page.

## Consequences
- + Total, page count, jump to page and page size, as users asked
- + One convention for all lists; simpler than keeping two on one endpoint
- − A row added meanwhile (upload, polling) shifts rows between pages; acceptable for a work list, mostly seen on page 1
- − The page and the total are two statements in one READ COMMITTED transaction: a row inserted between them can make `total` differ from the rows shown by one until the next refresh (polling). Not worth REPEATABLE READ for a list
- − `OFFSET` reads and discards the earlier rows and `count(*)` scans the filtered set; fine at this size, capped by `page <= 10 000`
- − The keyset code written first in T2.6 is removed (its lessons stay: tie-break `id`, `NULLS` placement that matches the index)

## Revisit when
A list passes about 100 000 rows per tenant, or `count(*)` or deep pages show in the p95 of NFR-02: switch that list to a cursor with an approximate total.
