# Live updates

## Scope

The two socket events named in the brief: when each is sent and how a receiver
treats it (payload fields: `packages/contracts`). It answers Core feature 1 of
the [requirements](../REQUIREMENTS.md), Core feature 2 and the quality
expectations.

## Behavior

**Interpretation** of "Updates live via WebSocket … (`rate:update`,
`rate:limit_exceeded`)": the brief is silent on timing; rules 1 and 2 read it.

1. `rate:update` is sent for every admitted request, also one over the cap
   during a suspension, and every admin action, after its write and before
   its HTTP response; never for a rejection or a failed action ([P15]).
   (Core feature 1; Core feature 3)
2. `rate:limit_exceeded` is sent for a user's first rejection in a window
   ([P6]). A reset, an extra grant and every successful limit save, even to a
   lower or equal value, allow one more; a suspension does not. A bookkeeping
   outage preserves the 429 without an alert; an error reply or defect gives 500
   without an event ([rate limiting, rule 10](rate-limiting.md#behavior)).
   (Core feature 1; Backend 6)
3. Both payloads carry the full row, built by the function that builds the HTTP
   row; an action's event row equals its response row. (Core feature 1;
   Expectation: performance)
4. `version` is a per-user counter, raised in the same transaction as every
   admission, rejection and admin action and read in it, so it matches the state
   shown with it. A suspension ending, a new hour and the removal of a rejected
   entry change a row without changing it. (Expectation: reliability)
5. Every connected dashboard receives every event, with no rooms; clients send
   none. A socket that fails the [handshake](platform.md#behavior) check
   receives nothing. **Interpretation** of "Real-time event stream for that
   user": the view filters by `userId`. (Core feature 2; Expectation: security)
6. A failed emit is logged and never fails the request or action that caused it;
   nothing is retried or replayed. (Expectation: reliability)

7. Of two rows of one user the newer has the later `resetAt`, then the higher
   `version`. An event, an action's response or a detail response replaces the
   held row only if strictly newer, so they may arrive in either order and a
   repeat changes nothing ([P19]). A `rate:limit_exceeded` that is not newer is
   dropped whole, alert included. (Core feature 1; Expectation: reliability)
8. An event never causes a request. A snapshot (the user list of
   [admin-api](admin-api.md#interface)) replaces a held row unless the held one
   is newer, so it also replaces an equal row that differs, repairing an ended
   suspension or a removed rejected entry. Snapshots run one at a time, requests
   meanwhile merge into one follow-up, a failed one keeps the rows. (Core
   feature 1; Expectation: reliability)
9. A snapshot is requested on every (re)connect, after a failed admin action,
   when the page becomes visible and, only while visible, at the next reset time
   of a held row and every 10 seconds. (Core feature 1; Expectation:
   reliability)
10. "Last update" is the `at` of the last applied event or the time of the last
    successful snapshot; connecting alone does not set it. (Core feature 1)
11. One hook owns the socket, removes the callbacks and timers it added and
    does nothing after its session ends ([P21]). (Expectation: maintainability)
12. An event reaches the dashboards of every API process that shares the
    Redis, not only those of the process that sent it ([P20]). A failed relay
    is logged and never fails a request or ends the process; after a Redis
    outage, relaying resumes without a restart. (Expectation: scalability;
    Expectation: reliability)

## Interface

Socket.IO on the HTTP port, default path and namespace, server to client:
`rate:update` (`RateUpdateEvent`, rule 1) and `rate:limit_exceeded`
(`RateLimitExceededEvent`, rule 2). The shared `ServerToClientEvents` map types
every emit, so a renamed event fails to compile ([P1]). Between API processes,
the Socket.IO Redis adapter relays each emit over Redis Pub/Sub, on channels
named with the prefix `socket.io` (rule 12).

## Decisions

**Full row, with a version.** Events that only name a user force a read each,
overtaken under steady traffic ([P18]). The event carries the row and a counter
from one transaction, so the store orders concurrent changes; a timestamp would
depend on host clocks. Cost: larger messages. Cases: mocked-store specs.

**One alert per window, re-armed by a generation.** A blocked client retries at
once, so an alert per 429 multiplies work. The once-per-window flag is keyed by
a generation, read with the admission's decision and incremented by reset, extra
and limit saves. Deleting the flag instead lets a rejection decided before the
action set it again; re-arming only on a raised limit needs a read and a retry.
Cost: lowering a limit can alert again that hour. Cases: interceptor and store
specs.

**Window, then version; snapshots repair.** Arrival order does not say which row
is newer, and a new hour changes a row with no event, so the window comes first.
Only a snapshot, read with its version in one transaction, may replace an equal
row. Last arrival wins undoes a newer event; cancelling a snapshot can starve
the display. Cost: a read every 10 seconds per visible dashboard (unmeasured),
and that long a stale row for changes no event carries. Cases: browser tests.

**Socket.IO Redis adapter.** A dashboard connected to one API process must see
the decisions of another ([P20]). The adapter publishes every emit on Redis and
each process delivers it to its own sockets. It does not await its Redis
commands, so with Redis down an emit would become an unhandled rejection, which
ends a Node process; its two connections therefore report a failed command
instead, and are separate from the main client so that this changes nothing
else. A reconnect restores only the subscriptions Redis confirmed, so a
subscription that failed with its connection is sent again once it is back.
Alternatives: one process, whose events stay local; a hand-written Pub/Sub
channel, which repeats the adapter; a message broker, a new service. Cost: two
more Redis connections per process, and an event emitted while Redis is
unreachable is lost. Cases: the delivery rows of the test plan.

## Test plan

| Mocked store (`npm test`) | Cases |
| --- | --- |
| `apps/api/src/live/live.gateway.spec.ts`, `apps/api/src/rate-limit/rate-limit.interceptor.spec.ts` | Admin handshake accepted; missing, wrong and user tokens refused. A failing emit is logged, not thrown; admissions, also bypassed, emit `rate:update`; rejections do not; only a first rejection alerts; a failed recording never alerts. |
| `apps/api/src/rate-limit/rate-limit.store.spec.ts` | The version rises once per admission and is read in the same transaction; the alert flag is keyed by the generation read with the decision. Admin actions increment the version and re-arm the alert where required. |
| `apps/api/src/admin/admin.controller.spec.ts` | Successful actions wait for the write, then emit the same row they return; failed actions never emit. |
| `apps/api/src/live/redis-io.adapter.spec.ts` | A failed publish is reported and resolves; a working one still publishes; a failed subscription is reported and sent again once the connection is ready. |

| Browser environment (`npm test`) | Cases |
| --- | --- |
| `apps/web/src/live/rows.test.ts`, `apps/web/src/live/useLiveUsers.test.tsx` | Order by window, then version; only a snapshot replaces an equal row; each snapshot trigger; one in flight, one merged follow-up; a newer event beats a slow snapshot; a failed snapshot keeps the rows; a stale alert is dropped; cleanup. |
| `apps/web/src/App.test.tsx`, `apps/web/src/assembled.test.tsx` | Connecting sets no update time; an event or a snapshot moves it. |

| Real store ([how to run](rate-limiting.md#test-plan)) | Cases |
| --- | --- |
| `apps/api/test/live-events.e2e-spec.ts` | An admitted request reaches a connected socket client as `rate:update` with the exact row and request. |
| `apps/api/test/alerts.e2e-spec.ts` | One `rate:limit_exceeded` per burst of rejections; a reset, a grant and a limit change each re-arm it without alerting; a rejection recorded late cannot use up the alert of the generation after such an action. |
| `apps/api/test/admin-http.e2e-spec.ts` | A handshake with a missing or a user token is refused; every request and every admin action emits its full row with a rising version. |
| `apps/api/test/cross-process.e2e-spec.ts` | A request to one application reaches a dashboard connected to a second one on the same Redis; a server on the Redis adapter refuses a dashboard with a wrong token; a dashboard whose application loses its Redis connection and gets it back, without a restart, receives the event of a request to the other application. With Redis stopped, a publish is reported, not rejected; a subscription survives a hang and the reconnect that follows it. |

| Two processes ([how to run](../../README.md#commands)) | Cases |
| --- | --- |
| `scripts/two-process-check.mjs` | One dashboard per process, connected before a burst that both processes serve, each receive the burst's single `rate:limit_exceeded`, with the same request ID: one process emitted it, so the other received it through Redis. A request and a reset handled by the second process reach a dashboard connected to the first. |

## Milestone

After `npm ci`, `cp .env.example .env`, `docker compose up -d redis` and
`npm run start:dev -w apps/api`, act as a dashboard in another terminal over
Engine.IO polling:

```sh
U='http://localhost:3000/socket.io/?EIO=4&transport=polling'
c() { curl -sw '\n' "$@"; }; sid() { c "$U" | sed -E 's/.*"sid":"([^"]+)".*/\1/'; }
S=$(sid); c -d '40{"token":"demo-admin-token"}' "$U&sid=$S"; c "$U&sid=$S"
c -H 'Authorization: Bearer demo-token-01' localhost:3000/api/sample; c "$U&sid=$S"
B=$(sid); c -d '40{"token":"wrong"}' "$U&sid=$B"; c "$U&sid=$B"
```

It prints `ok`, `40{"sid":"…"}`, the sample body, one
`42["rate:update",{"cause":"request",…}]` frame (on an empty store `remaining`
99, `version` 1), then `ok` and `44{"message":"Unauthorized"}`, the refusal.

```sh
# Second terminal, from the repository root (socket.io-client is installed from here on)
node --input-type=module -e "import { io } from 'socket.io-client'; io('http://localhost:3000', { auth: { token: 'demo-admin-token' } }).onAny((name, e) => console.log(name, JSON.stringify(e)))"
# Third terminal
U=http://localhost:3000; T='Authorization: Bearer demo-token-03'
curl -s -H "$T" $U/api/sample
curl -s -X PUT -H 'Authorization: Bearer demo-admin-token' -H 'Content-Type: application/json' -d '{"limit":1}' $U/api/admin/users/user-03/limit
curl -s -H "$T" $U/api/sample; curl -s -H "$T" $U/api/sample
```

The watcher prints, for `user-03`: `rate:update` (cause `request`, on an empty
store `remaining` 99, `version` 1); `rate:update` (cause `limit`, status
`Exceeded`); one `rate:limit_exceeded` with `retryAt` at the next hour. The last
call answers 429 and prints nothing. With `npm run dev` and the
[dashboard](dashboard.md#behavior) signed in, repeat the first request: the
`user-03` row changes in place, with no request made because of the event.

Across processes, on the Redis server of the
[real-store suite](rate-limiting.md#test-plan), whose database the check
empties:
`npm run build && npm run check:two-process`. The output contains
`One rate:limit_exceeded event, the same at the dashboards on both processes`,
`Cross-process request event received` and `Cross-process reset event received`,
and the exit code is 0.

## Limits

- Two processes emit in no set order; the version orders the rows (rule 7). A
  client that polls through a load balancer needs session affinity, which is
  neither provided nor tested.
- Delivery across processes is shown on two processes of one host and one
  Redis, not under load. No throughput or latency figure is measured.
- Events are not stored, replayed or acknowledged; during a suspension every
  request sends an update, so volume has no bound there.

[P1]: ../PITFALLS.md#p1-renaming-what-the-brief-names
[P6]: ../PITFALLS.md#p6-rejections-that-multiply-work
[P15]: ../PITFALLS.md#p15-answering-before-the-write-has-settled
[P18]: ../PITFALLS.md#p18-events-that-only-say-something-changed
[P19]: ../PITFALLS.md#p19-an-older-snapshot-overwriting-a-newer-event
[P20]: ../PITFALLS.md#p20-taking-a-connection-for-delivery
[P21]: ../PITFALLS.md#p21-removing-another-components-listeners
[P24]: ../PITFALLS.md#p24-tests-that-do-not-exercise-what-runs
