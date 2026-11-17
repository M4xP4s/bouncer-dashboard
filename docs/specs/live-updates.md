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

## Interface

Socket.IO on the HTTP port, default path and namespace, server to client:
`rate:update` (`RateUpdateEvent`, rule 1) and `rate:limit_exceeded`
(`RateLimitExceededEvent`, rule 2). The shared `ServerToClientEvents` map types
every emit, so a renamed event fails to compile ([P1]).

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

## Test plan

| Mocked store (`npm test`) | Cases |
| --- | --- |
| `apps/api/src/live/live.gateway.spec.ts`, `apps/api/src/rate-limit/rate-limit.interceptor.spec.ts` | Admin handshake accepted; missing, wrong and user tokens refused. A failing emit is logged, not thrown; admissions, also bypassed, emit `rate:update`; rejections do not; only a first rejection alerts; a failed recording never alerts. |
| `apps/api/src/rate-limit/rate-limit.store.spec.ts` | The version rises once per admission and is read in the same transaction; the alert flag is keyed by the generation read with the decision. Admin actions increment the version and re-arm the alert where required. |
| `apps/api/src/admin/admin.controller.spec.ts` | Successful actions wait for the write, then emit the same row they return; failed actions never emit. |

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

## Limits

- Events reach clients connected to this API process only.

- The dashboard, per-user stream filtering and snapshot repair are not present yet.

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
