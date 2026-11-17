# Admin API

## Scope

The four admin actions, the read model and its storage. Answers (Core feature 1;
Core feature 2; Core feature 3; Core feature 5; Backend 5; Backend 7;
Expectation: security; Expectation: reliability; Expectation: scalability).

## Behavior

1. **Checks first.** A refused request changes and emits nothing. The HTTP
   parser rejects malformed or oversized JSON (400 or 413). After parsing,
   the [platform](platform.md#behavior) checks the credential (401) before
   the route checks user ID (404) or action input (400). (Expectation:
   security; [P16])
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
8. **List, detail, history.** One row per user, by ID; detail adds up to 100
   recent requests less than 24 hours old, newest first (ties by request ID).
   **Interpretation:** "short activity history (past hour/day)" shows 60 minute
   buckets or 24 UTC hour buckets, oldest first, including the current bucket
   and filling empty buckets with zero. (Core feature 1; Core feature 2)
9. **Analytics** use the list's rows. **Interpretation:** "% near limit" is the
   share of users with counted requests this window at Warning or Exceeded,
   rounded to the nearest integer, 0 when none. "429 count today" uses the UTC
   day. "Top users" ranks up to five active users by usage, highest first.
   The order of ties is unspecified. (Core feature 5; [P4])

## Interface

| Route under `/api/admin`; admin bearer token | Body | Answer | Errors |
| --- | --- | --- | --- |
| `GET /users` | none | `UserRow[]` | 401 503 |
| `GET /users/:id` | none | `UserDetail` | 401 404 503 |
| `GET /users/:id/history?range=` | none | `HistoryBucket[]` | 400 401 404 503 |
| `GET /analytics` | none | `Analytics` | 401 503 |
| `POST /users/:id/reset`, `DELETE /users/:id/suspension` | none | `UserRow` | 401 404 503 |
| `PUT /users/:id/limit` | `SetLimitBody` | `UserRow` | 400 401 404 503 |
| `POST /users/:id/suspension` | `SuspendBody` | `UserRow` | 400 401 404 503 |
| `POST /users/:id/extra` | `ExtraBody` | `UserRow` | 400 401 404 503 |

Reads use the Redis keys defined in [Rate limiting](rate-limiting.md#interface).

## Decisions

**Admin writes and admission.** Asked: concurrency-proof limiting (Backend 5)
with controls acting mid-window. Each action is one `MULTI`/`EXEC` transaction
on admission's instance, ending in a version increment and a row read, so the
returned row reflects the action at its place in that order. `WATCH` with
retry costs round trips, a lock can outlive its holder, scripts add a language.
Cost: the write queues the row read as well as the mutation.

**Usage, limit and grant apart.** These values follow different lifetimes.
Admission and admin reads use the same keys and row builder. A single counter
could preserve an expired grant or erase usage when a limit changes ([P13]).
Cost: five commands per row read.

## Test plan

Mocked store (`vitest-mock-extended`; the test supplies the time):
- `apps/api/src/admin/admin.controller.spec.ts`: check order; a refused call
  never reaches the store or emits; the answer waits for the write; 503, 500.
- `apps/api/src/rate-limit/rate-limit.store.spec.ts` (admin actions, reads):
  reset deletes only window and grant; no other action writes usage; version
  and row read in the action's transaction; history buckets.
- `apps/api/src/admin/analytics.spec.ts`: near-limit share, ranking, idle zero.

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
| 11 Refusals | `curl -s -w ' %{http_code}\n' -X PUT -H "$ADMIN" -H "$JSON" -d '{"limit":1.5}' $USER7/limit`; `curl -s -w ' %{http_code}\n' -X POST -H "$ADMIN" http://localhost:3000/api/admin/users/nobody/reset`; `curl -s -w ' %{http_code}\n' http://localhost:3000/api/admin/users` | in turn: `limit must be an integer number` 400; `Unknown user.` 404; `A valid admin token is required.` 401 |

## Limits

Mocked cases check the commands queued. The HTTP milestone exercises one API
process without concurrent writes. History and counters are recorded separately
from admission; analytics reads rows and the daily count in separate
transactions. List and analytics read all configured users.

[P4]: ../PITFALLS.md#p4-a-near-limit-figure-that-drops-when-users-get-blocked
[P12]: ../PITFALLS.md#p12-a-temporary-suspension-that-never-ends
[P13]: ../PITFALLS.md#p13-usage-base-limit-and-grant-in-one-number
[P14]: ../PITFALLS.md#p14-a-reset-that-resets-the-policy-and-not-the-usage
[P15]: ../PITFALLS.md#p15-answering-before-the-write-has-settled
[P16]: ../PITFALLS.md#p16-admin-input-that-reaches-the-store-unchecked
[P17]: ../PITFALLS.md#p17-retrying-an-admin-action-automatically
