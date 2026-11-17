# Rate limiting

## Scope

The per-user quota: windows, row and status, admission, `x-count`, the 429 and
503, the keys, `RateLimitInterceptor` and its sample route. It answers Backend 1
to 7 of [the requirements](../REQUIREMENTS.md), Core features 1 to 4 in part and
reliability, cited (Backend 5), (Core feature 1), (Expectation: reliability).

## Behavior

1. **Interpretation of "Resets the count every hour".** The window is one UTC
   clock hour: zero at each boundary, Reset Time the next one. One clock
   reading per request decides window and suspension. (Backend 3; [P25])
2. The cap is the limit (100 unless a custom one is stored) plus the window's
   extra grant. Counting a request and fixing its position is one store
   transaction, so concurrent requests never pass it. (Backend 5; [P24])
3. **Interpretation of "Limits each user to 100 requests per hour".** An
   admitted request uses one unit even if its handler fails; a rejected one
   none: its row leaves it out and rule 10 removes its entry. (Backend 3)
4. Over the cap while the stored suspension end is later than the request's
   clock reading, a request is admitted as bypassed and counted. The end time
   decides, not whether the key exists. (Core feature 3; [P12])
5. One function, `buildRow`, builds every `UserRow`, so the table cannot
   disagree with the limiter. (Core feature 1; Core feature 2)
6. **Interpretation of "Warning >= 90%, OK <= 90%".** Exactly 90% sits in two
   bands; it is Warning. Exceeded at usage >= cap, else Warning when
   `used * 10 >= total * 9`, in integers. (Core feature 4; [P3])
7. Every admitted request, bypassed ones too, carries `x-count`: the remaining
   quota in the row its own admission produced (99 for a fresh user, 0 for the
   hundredth), never read again. (Backend 4; [P2])
8. A rejected request gets 429 with `x-count: 0`, no handler run and a
   `RateLimitedError` body: `message` "Rate limit of 100 requests per hour
   exceeded. Try again at HH:00:00 UTC." at the default cap (the message uses
   the effective cap), `retryAt` (the next boundary),
   `retryAfterSeconds`. **Addition:** `Retry-After`, whole seconds rounded up,
   at least 1. (Backend 6)
9. During admission, a disconnected client or a transaction rejection that is
   not the Redis client's `ErrorReply` becomes `StoreUnavailable`: 503 "The
   request was not processed. It may be retried." without `x-count`, and no
   handler runs. A Redis `ErrorReply` (including `MultiErrorReply`) propagates
   to the generic 500 handler; its details are logged, not returned. Neither
   response promises that quota was untouched. No retry or per-process fallback.
   Errors outside transaction execution remain 500. (Expectation: reliability; [P8])
10. Bookkeeping, a second transaction before the handler, removes a rejected
    entry and records the outcome. `StoreUnavailable` is logged and preserves
    the admission or 429; a rejected request emits no alert in that case.
    An `ErrorReply` or other defect instead produces a generic 500 without
    `x-count`, handler execution or events, even after admission or denial.
    Completed Redis writes are not rolled back and admitted quota is not refunded.
    When bookkeeping succeeds or only the store is unavailable,
    admitted requests emit `rate:update`; a rejection emits
    `rate:limit_exceeded` only as the first for its user, window and re-arm
    generation ([live-updates](live-updates.md#behavior)).
    (Core feature 1; [P6], [P7])

## Interface

`GET /api/sample` (`SampleResponse`) and `GET /api/sample/fail` (same quota,
then fails) alone use `RateLimitInterceptor` (Backend 2), after the identity
guard ([platform](platform.md#behavior)); a missing or wrong token is 401 and
counts nothing.

| Key (`{u}` user ID, `{h}` window start in ms, `{g}` generation) | Holds | Expiry ([P9]) |
| --- | --- | --- |
| `rl:win:{u}:{h}` | sorted set, one request ID per counted request | end + 1 h |
| `rl:extra:{u}:{h}`, `rl:notified:{u}:{h}:{g}` | grant; flag: alert sent | end + 1 h |
| `rl:suspend:{u}` | suspension end, ms since the epoch | at that time |
| `rl:limit:{u}`, `rl:user:{u}` | custom limit; hash `v`, `g`, last request and reset times | none; per user |
| `rl:hist:{u}` | at most 100 recent request records | 24 h after last write |
| `rl:stat:{u}:{h}` | admitted/denied counts by minute | 25 h after window start |
| `rl:denied:{UTC day}` | daily rejection count | 48 h after last write |

## Decisions

### Concurrent safety

Backend 5 asks that no request slip through, so the
decision rests on a position the write itself claims, read with the policy in
the same transaction. One `MULTI`/`EXEC` per request: `ZADD` a unique ID,
`PEXPIREAT`, bump the version and last request time, then `ZCARD` and the policy
reads. TypeScript compares the count, which includes the request, with the cap;
the bookkeeping removes a rejection's ID. A store-side script decides in one
trip but moves the logic away from the mocked tests. `INCR` plus `EXPIRE` can
leave a key without expiry ([P5]), and a late decrement after a reset admits
one too many. Cost: a second round trip per request; rejected and bypassed
entries stay until removed or expired.

### Fixed hour

A rolling window is exact but needs another structure; the fixed
hour allows twice the cap across a boundary and needs synchronized clocks. Keys
expire an hour late so a slow clock never counts 1 on a deleted key.

### Error classification

Classify by the client's error type in
one transaction wrapper: a server error reply is surfaced as 500; other
execution failures are treated as unavailable. This avoids labelling wrong-type
keys as an outage. Parsing message prefixes would couple policy to error text;
a larger catalogue of transient replies is deferred. Bookkeeping tolerates
unavailability, but exposes error replies and defects rather than hiding them.

## Test plan

Mocked store (`vitest-mock-extended`), no Redis, in `apps/api/src/`:
- `rate-limit/rate-limit.store.spec.ts`: cap, bypass, command order, outage;
  admission and bookkeeping preserve Redis error replies unwrapped.
- `rate-limit/rate-limit.interceptor.spec.ts`,
  `sample/sample.controller.spec.ts`: headers, 429, 503, events; bookkeeping
  defects propagate for both admitted and denied requests without running the handler.
- `rate-limit/row.spec.ts`: status around the 90% line, limits 100 and 11.
- `rate-limit/keys.spec.ts`: a millisecond around the boundary, also for the
  window key; expiry.

Real store, in `apps/api/test/`, started with the whole application (the
command, and the Redis server of its own that the suite needs, are in the
[README](../../README.md#verification); the suite empties the database it uses):
- `admission.e2e-spec.ts`: `x-count` 99 down to 0, then the 429; the quota
  changes exactly at the UTC hour ([P25]); one user's exhaustion leaves
  another's quota; a failing handler still counts; a 401 and a spoofed ID
  count nothing.
- `concurrency.e2e-spec.ts`: 200 concurrent requests admit exactly 100 with
  distinct `x-count` values ([P24]); a reset or a grant between two batches
  keeps every later admission; during 1000 rejections, 20 requests of
  another user take under 1 s each, a loose smoke bound ([P7]); every
  snapshot pairs usage and version.
- `store-races.e2e-spec.ts`: clocks on both sides of an hour admit at most
  one cap per hour; a skipped rejection cleanup only lowers capacity, until
  a reset; recent requests are ordered by time and ID, not by completion.
- `expiry.e2e-spec.ts`: every key written has the expiry of its rule ([P9]);
  a suspension and an hour that end while idle change the snapshot at the
  same version; a record leaves the detail at exactly 24 h.

Two API processes on one Redis, in `scripts/two-process-check.mjs`
(`npm run check:two-process` after a build, on the Redis server of the
real-store suite, whose database it empties): one request through each
process uses one quota (99, then 98 remaining); 200 concurrent requests
spread over both admit exactly 100, with each `x-count` from 0 to 99 once,
and the window holds 100 entries.

## Milestone

```sh
npm ci && cp .env.example .env && docker compose up -d redis
npm test && npm run start:dev -w apps/api
for h in 'X-None: 1' 'Authorization: Bearer wrong'; do
  curl -si -H "$h" localhost:3000/api/sample | head -1; done
for i in $(seq 101); do curl -si -H 'Authorization: Bearer demo-token-03' \
  localhost:3000/api/sample | grep -iE '^(HTTP|x-count|retry-after)'; done
```

In a second shell, expect `HTTP/1.1 401` twice, then `x-count` 99 down to 0 (the
401s counted nothing), then `HTTP/1.1 429` with `Retry-After` up to 3600,
`x-count` 0 and the body of rule 8. After `docker compose stop redis` a request
gets 503 without `x-count` once the disconnect is detected; no total request
deadline is promised. After `docker compose start redis` and then
`docker compose pause redis`, a request waits and gets the same 503 within
about 4 s ([platform](platform.md#behavior), rule 7); after
`docker compose unpause redis` requests succeed again without a restart.

## Limits

All Redis error replies become 500, including potentially temporary `LOADING`,
`BUSY`, `READONLY` and out-of-memory replies. Conversely, a non-`ErrorReply`
execution failure is classified as unavailable without proving it is temporary.
A bookkeeping error reply can replace a planned success or 429 with 500 after
quota or telemetry writes have already happened; there is no rollback or retry.


Mocked-store tests cannot show shared-store atomicity. A boundary burst of twice
the cap is possible; bypassed requests and a failed cleanup leave entries above
the cap until the key expires. A silent Redis holds a request for up to
about 4 s ([platform](platform.md#behavior), rule 7). One Redis only.

[P2]: ../PITFALLS.md#p2-putting-the-used-count-in-x-count
[P3]: ../PITFALLS.md#p3-a-status-threshold-that-only-works-for-round-limits
[P5]: ../PITFALLS.md#p5-setting-the-count-and-its-expiry-in-two-steps
[P6]: ../PITFALLS.md#p6-rejections-that-multiply-work
[P7]: ../PITFALLS.md#p7-one-users-flood-slowing-everyone-else
[P8]: ../PITFALLS.md#p8-catching-every-error-around-the-store-call
[P9]: ../PITFALLS.md#p9-storing-something-without-a-bound
[P12]: ../PITFALLS.md#p12-a-temporary-suspension-that-never-ends
[P24]: ../PITFALLS.md#p24-tests-that-do-not-exercise-what-runs
[P25]: ../PITFALLS.md#p25-time-tests-that-do-not-control-time
