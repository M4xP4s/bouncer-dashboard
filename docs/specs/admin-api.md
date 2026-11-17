# Admin API

## Scope

The four admin actions, the read model with its paged user list, and its
storage. Answers (Core feature 1; Core feature 2; Core feature 3; Core
feature 4; Core feature 5; Backend 5; Backend 7; Expectation: security;
Expectation: reliability; Expectation: scalability; Expectation:
performance).

## Behavior

1. **Checks first.** A refused request changes and emits nothing. The HTTP
   parser rejects malformed or oversized JSON (400 or 413). After parsing,
   the [platform](platform.md#behavior) checks the credential (401) before
   the route checks user ID in the registry (404), list query or action
   input (400). A route with a user ID answers in this order: 401, 400 for
   a malformed ID, 503 when the registry cannot be read, 404 for an ID not
   registered, and only then 400 for an invalid body or query value, so an
   unknown user is answered 404 before the body's values are validated.
   (Expectation: security; [P16])
2. **Bounds. Interpretation:** "Adjust limit (custom value)" and "temporarily"
   give no bounds. An action with a body accepts exactly one integer field:
   `limit` 1–10000, `minutes` 1–1440 or `amount` 1–10000. An invalid body or
   a missing or invalid history `range` gives 400. (Core feature 3; Expectation: security; [P16])
3. **Reset. Interpretation:** "Reset limit" resets usage, not the limit: it
   removes the window's usage and grant, keeps limit, suspension and history,
   and stamps the last reset time. (Core feature 3; [P14])
4. **Limit.** "Adjust limit (custom value)" is a base limit until changed.
   Usage and the grant stay. Once the cap is spent, the next request is
   rejected unless throttling is suspended. (Core feature 3)
5. **Suspension. Interpretation:** "Suspend or unlock throttling temporarily"
   needs an end, now plus `minutes`, that admission compares with its own
   clock, so no job ends it; over-cap requests are admitted and counted.
   Unlock ends it early. (Core feature 3; [P12])
6. **Extra. Interpretation:** "Add extra requests within current window" raises
   this UTC-hour window's cap by `amount`; grants add up, leave usage alone
   and end at the hour. (Core feature 3; [P13])
7. **Settled, then answered.** A successful action returns 200 with the `UserRow`
   from its transaction. [Live updates](live-updates.md#behavior) defines
   when it emits an event and re-arms an alert. An unavailable store gives
   503; Redis error replies and other defects give 500. The action is not
   retried: a failed or lost reply does not prove nothing was written.
   (Expectation: reliability; [P15]; [P17])
8. **List, detail, history.** The list is one page of rows, one per user, in
   plain string order of the ID (rule 10); detail adds up to 100 recent
   requests less than 24 hours old, newest first (ties by request ID).
   **Interpretation:** "short activity history (past hour/day)" shows 60 minute
   buckets or 24 UTC hour buckets, oldest first, including the current bucket
   and filling empty buckets with zero. (Core feature 1; Core feature 2)
9. **Analytics** count every registered user, whatever page or filter the
   list shows. **Interpretation:** "% near limit" is the share of users with
   counted requests this window at Warning or Exceeded, rounded to the
   nearest integer, 0 when none. "429 count today" uses the UTC day. "Top
   users" ranks up to five active users by usage, highest first, equal usage
   by user ID. (Core feature 5; [P4])
10. **List query.** `page` from 1 (default 1) and `pageSize` from 1 to 100
    (default 50), in plain decimal digits; `search` at most 64 characters,
    matched as a case-insensitive substring of the ID (default empty);
    `status` `any`, `OK`, `Warning` or `Exceeded` (default `any`); `active`
    `any`, `5m`, `1h` or `24h` (default `any`), kept when the last request is
    at or after the read's start minus that period, so a user who never
    called matches only `any`. An unknown, repeated or out-of-range field is
    400. Every filter applies to all registered users before the page is cut;
    `total` counts all matches, and a page past the last has no rows. (Core
    feature 4; Expectation: security; [P16])
11. **Reads in batches.** An unfiltered page reads only its own IDs and rows.
    A filtered page and the analytics read every registered user in ID
    order, 100 rows per transaction, keeping only the page, the counts and
    the top five. Each row is consistent with its version, but the whole is
    not one snapshot: a user can change between two batches. A read stops at
    the last ID registered when it began. `startedAt` and `completedAt` give
    its interval. (Expectation: performance; Expectation: reliability; [P9])

## Interface

| Route under `/api/admin`; admin bearer token | Body | Answer | Errors |
| --- | --- | --- | --- |
| `GET /users?page=&pageSize=&search=&status=&active=` | none | `UsersPage` | 400 401 503 |
| `GET /users/:id` | none | `UserDetail` | 400 401 404 503 |
| `GET /users/:id/history?range=` | none | `HistoryBucket[]` | 400 401 404 503 |
| `GET /analytics` | none | `Analytics` | 401 503 |
| `POST /users/:id/reset`, `DELETE /users/:id/suspension` | none | `UserRow` | 400 401 404 503 |
| `PUT /users/:id/limit` | `SetLimitBody` | `UserRow` | 400 401 404 503 |
| `POST /users/:id/suspension` | `SuspendBody` | `UserRow` | 400 401 404 503 |
| `POST /users/:id/extra` | `ExtraBody` | `UserRow` | 400 401 404 503 |

Reads use the Redis keys defined in [Rate limiting](rate-limiting.md#interface)
and the registry keys of [platform](platform.md#interface).

## Decisions

### Admin writes and admission

Asked: concurrency-proof limiting (Backend 5)
with controls acting mid-window. Each action is one `MULTI`/`EXEC` transaction
on admission's instance, ending in a version increment and a row read, so the
returned row reflects the action at its place in that order. `WATCH` with
retry costs round trips, a lock can outlive its holder, scripts add a language.
Cost: the write queues the row read as well as the mutation.

### Usage, limit and grant apart

These values follow different lifetimes.
Admission and admin reads use the same keys and row builder. A single counter
could preserve an expired grant or erase usage when a limit changes ([P13]).
Cost: five commands per row read.

### Numbered pages, filtered by reading in batches

Asked: a live table with
search and filters (Core features 1, 4) for a population that should scale.
Sending every row grows each response and each dashboard's memory with the
population, so the server cuts a page. Status and last activity change with
every request and at every hour boundary without a write, so an index on
them would have to be kept in the admission transaction and repaired each
hour; reading the rows in ID order, a batch at a time, keeps admission as it
is and bounds the memory a read holds. Alternatives: a cursor instead of
page numbers, which cannot show "page 3 of 20" or jump to the last page;
filtering in the browser, which needs every row; sorted-set indexes per
status. Cost: a filtered page and the analytics take time that grows with
the population, on every read. Cases: the user reads spec, the registry
cases.

## Test plan

Mocked store (`vitest-mock-extended`; the test supplies the time):
- `apps/api/src/admin/admin.controller.spec.ts`: check order, including 400
  for a malformed ID before the registry is read and 404 for an unknown user
  with an invalid value however late the registry answers; a refused call never reaches the store or emits; the answer
  waits for the write; 503, 500; a list query with an unknown, repeated or
  out-of-range field is 400 before any read.
- `apps/api/src/admin/user-reads.spec.ts`: an unfiltered page reads only its
  IDs; filters apply before the page is cut and `total` counts every match;
  a page past the end is empty; analytics add up every batch.
- `apps/api/src/rate-limit/rate-limit.store.spec.ts` (admin actions, reads):
  reset deletes only window and grant; no other action writes usage; version
  and row read in the action's transaction; history buckets.
- `apps/api/src/admin/analytics.spec.ts`: near-limit share, ranking with
  ties by ID, idle zero, rows added in batches.

Real store, in `apps/api/test/` (run as in
[rate limiting](rate-limiting.md#test-plan)):
- `admin-behavior.e2e-spec.ts`: reset clears usage and grant and keeps the
  limit; a lower limit keeps usage; a grant adds its slots and ends with the
  hour; a suspension bypasses, is counted, and ends on expiry or on request.
- `admin-http.e2e-spec.ts`: bad input (wrong type, fraction, out of range,
  extra field) and unknown users change nothing; an
  unknown user with an invalid body or history range is 404 and writes
  nothing; every route and the socket refuse a missing and a user token; an
  ID with uppercase, `_` and `-` survives every route ([P11]).
- `read-model.e2e-spec.ts`: snapshot, detail, `x-count` and analytics agree;
  the top users are ranked by usage, equal usage by ID; histories include
  the previous hour and zero-filled buckets; the stored list of recent
  requests stays capped at 100.
- `registry.e2e-spec.ts`: first, middle, last and past-the-end pages of
  10000 users; status, last activity and search count across all users;
  the page asked for leaves analytics unchanged; a read in batches ends at
  the last ID registered when it began; bad queries are 400.

## Milestone

With a fresh Redis (`docker compose up -d redis`), `cp .env.example .env` and
`npm run start:dev -w apps/api` running, in another shell set
`ADMIN='Authorization: Bearer demo-admin-token'`,
`JSON='Content-Type: application/json'` and
`USER7=http://localhost:3000/api/admin/users/user-07`, then run in order:

| Step | Command | Expect |
| --- | --- | --- |
| 1 Reset | `curl -s -X POST -H "$ADMIN" $USER7/reset` | a row with `"used":0`, `"limit":100`, `"status":"OK"` |
| 2 Lower the limit | `curl -s -X PUT -H "$ADMIN" -H "$JSON" -d '{"limit":2}' $USER7/limit` | `"limit":2`, `"total":2`, `"remaining":2` |
| 3 Use the quota | `for n in 1 2 3; do curl -s -o /dev/null -w '%{http_code} ' -H 'Authorization: Bearer demo-token-07' http://localhost:3000/api/sample; done` | `200 200 429` |
| 4 Detail | `curl -s -H "$ADMIN" $USER7` | `"used":2`, `"remaining":0`, `"status":"Exceeded"`; three `recentRequests`, `"outcome":"denied"` first, then two `"allowed"` |
| 5 History | `curl -s -H "$ADMIN" "$USER7/history?range=hour"` | 60 buckets whose counts add up to `"allowed":2` and `"denied":1`; `range=day` gives 24 |
| 6 Analytics | `curl -s -H "$ADMIN" http://localhost:3000/api/admin/analytics` | `"totalUsers":12`, `"activeUsers":1`, `"nearLimitPercent":100`, `"denied429Today":1`, `"topUsers":[{"userId":"user-07","used":2,"total":2}]` |
| 7 Grant | `curl -s -X POST -H "$ADMIN" -H "$JSON" -d '{"amount":1}' $USER7/extra` | `"extra":1`, `"total":3`, `"remaining":1`, `"used":2` |
| 8 Suspend | `curl -s -X POST -H "$ADMIN" -H "$JSON" -d '{"minutes":5}' $USER7/suspension` | `"suspendedUntil"` five minutes ahead |
| 9 Unlock | `curl -s -X DELETE -H "$ADMIN" $USER7/suspension` | `"suspendedUntil":null` |
| 10 Reset again | `curl -s -X POST -H "$ADMIN" $USER7/reset` | `"used":0`, `"extra":0`, `"limit":2` (reset keeps the limit) |
| 11 Refusals | `curl -s -w ' %{http_code}\n' -X PUT -H "$ADMIN" -H "$JSON" -d '{"limit":1.5}' $USER7/limit`; `curl -s -w ' %{http_code}\n' -X POST -H "$ADMIN" http://localhost:3000/api/admin/users/nobody/reset`; `curl -s -w ' %{http_code}\n' http://localhost:3000/api/admin/users`; `curl -s -w ' %{http_code}\n' -H "$ADMIN" "http://localhost:3000/api/admin/users?pageSize=101"` | in turn: `limit must be an integer number` 400; `Unknown user.` 404; `A valid admin token is required.` 401; `pageSize must not be greater than 100` 400 |
| 12 Page | `curl -s -H "$ADMIN" "http://localhost:3000/api/admin/users?page=2&pageSize=5"` | `"total":12`, `"page":2`, the rows of `user-06` to `user-10` |
| 13 Filter | `curl -s -H "$ADMIN" "http://localhost:3000/api/admin/users?search=USER-0&active=1h"` | `"total":1` and the row of `user-07`; without `&active=1h`, `"total":9` |

## Limits

Mocked cases check the commands queued. The HTTP milestone exercises one API
process without concurrent writes. History and counters are recorded separately
from admission; analytics reads rows and the daily count in separate
transactions. A filtered page and the analytics read every registered user
on each request: their time grows with the population, nothing bounds it,
and `npm run check:population` measures it on one machine only.

[P4]: ../PITFALLS.md#p4-a-near-limit-figure-that-drops-when-users-get-blocked
[P11]: ../PITFALLS.md#p11-a-user-id-that-is-not-one-plain-string
[P12]: ../PITFALLS.md#p12-a-temporary-suspension-that-never-ends
[P13]: ../PITFALLS.md#p13-usage-base-limit-and-grant-in-one-number
[P14]: ../PITFALLS.md#p14-a-reset-that-resets-the-policy-and-not-the-usage
[P15]: ../PITFALLS.md#p15-answering-before-the-write-has-settled
[P16]: ../PITFALLS.md#p16-admin-input-that-reaches-the-store-unchecked
[P17]: ../PITFALLS.md#p17-retrying-an-admin-action-automatically
