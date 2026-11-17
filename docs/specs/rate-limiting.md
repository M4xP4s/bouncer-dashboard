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
9. If the store is unavailable (Redis down, or its transaction fails) the answer
   is 503 "The request was not processed. It may be retried." without `x-count`,
   and the handler does not run; the message claims nothing about the quota. No
   retry and no per-process fallback (it would allow the cap once per process).
   Any other error is a 500. (Expectation: reliability; [P8])
10. Bookkeeping, a second transaction before the handler, removes a rejected
    entry and records the outcome; its failure never changes the answer.
    Admitted requests emit `rate:update`; a rejection emits
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

**Concurrent safety.** Backend 5 asks that no request slip through, so the
decision rests on a position the write itself claims, read with the policy in
the same transaction. One `MULTI`/`EXEC` per request: `ZADD` a unique ID,
`PEXPIREAT`, bump the version and last request time, then `ZCARD` and the policy
reads. TypeScript compares the count, which includes the request, with the cap;
the bookkeeping removes a rejection's ID. A store-side script decides in one
trip but moves the logic away from the mocked tests. `INCR` plus `EXPIRE` can
leave a key without expiry ([P5]), and a late decrement after a reset admits
one too many. Cost: a second round trip per request; rejected and bypassed
entries stay until removed or expired.

**Fixed hour.** A rolling window is exact but needs another structure; the fixed
hour allows twice the cap across a boundary and needs synchronized clocks. Keys
expire an hour late so a slow clock never counts 1 on a deleted key.

## Test plan

Mocked store (`vitest-mock-extended`), no Redis, in `apps/api/src/`:
- `rate-limit/rate-limit.store.spec.ts`: cap, bypass, command order, outage.
- `rate-limit/rate-limit.interceptor.spec.ts`,
  `sample/sample.controller.spec.ts`: headers, 429, 503, events.
- `rate-limit/row.spec.ts`: status around the 90% line, limits 100 and 11.
- `rate-limit/keys.spec.ts`: a millisecond around the boundary; expiry.

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
deadline is promised. A paused server can keep requests pending under traffic:
the socket timeout measures inactivity, and writes restart it.

## Limits

Mocked-store tests cannot show shared-store atomicity. A boundary burst of twice
the cap is possible; bypassed requests and a failed cleanup leave entries above
the cap until the key expires. A silent Redis holds requests as long as the
connection settings allow ([platform](platform.md#behavior)). One Redis only.

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
