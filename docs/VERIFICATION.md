# Verification

What was run in this repository, at which revision, and what each run showed.
Planned cases are in each specification's test plan; this document holds
results only. A check that is not listed here was not run.

## Revision and environment

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revision     | Tree `ca53c5b800efeffb5527152b8313ad09e7baf5f3`, which is `main` at commit `bf206fb` (pull request #20), for the first six commands below. The population check, the Compose start, the pause timing and the browser pass are from tree `6c0cf6ef3ab2a196f1099a594fa1229774af135a`, `main` at `8581c61` (pull request #16); since then the application source changed in two files, `apps/web/src/live/liveSession.ts` and `apps/api/src/users/seed-users.ts` |
| Date         | 2026-11-17                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Machine      | One laptop: Apple M3 Pro, 18 GB memory, macOS 26.2                                                                                                                                                                                                                                                                                                                                                                                                            |
| Node.js, npm | 26.5.0, 11.17.0                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Docker       | 29.8.2                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Redis        | 8.10.3 (`redis:8-alpine`), one instance in Docker, used by nothing else during the runs                                                                                                                                                                                                                                                                                                                                                                       |
| Browser      | Chromium 151.0.7922.34 driven by Playwright, headless, 1440 by 900 pixels                                                                                                                                                                                                                                                                                                                                                                                     |

## Automated checks

Commands as in the [README](../README.md#verification), from a fresh checkout
after `npm ci`, run one after another on a Redis server of their own. That
server listened on another free port than the README's 6380; nothing else
differed.

| Command                            | What it runs                                                                                                                                                                                           | Result                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                    | The API and the dashboard build, each compiling the shared contract types it imports                                                                                                                   | Exit 0 in 7.0 s. Vite warns that the dashboard's JavaScript file is 966 kB (289 kB gzipped), above its 500 kB notice                                              |
| `npm run lint`                     | Type-aware lint of the API (explicit `any` is an error) and the dashboard                                                                                                                              | Exit 0 in 4.4 s, nothing reported                                                                                                                                 |
| `npm test`                         | API: unit tests with the store mocked, controller tests over HTTP and Redis-client tests against a local TCP peer. Dashboard: component and hook tests in jsdom with a mocked socket. No Redis server. | Exit 0 in 25.7 s. API: 295 tests in 16 files passed. Dashboard: 127 tests in 14 files passed                                                                      |
| `npm run check:contracts`          | The fixture data against the dashboard's own shape checks                                                                                                                                              | Exit 0, `fixtures consistent: 134 checks passed`                                                                                                                  |
| `npm run test:integration`         | The built application over HTTP and Socket.IO against a real Redis                                                                                                                                     | Five runs in a row, each exit 0: 74 tests in 14 files passed, none skipped, in 29.8 to 30.7 s                                                                     |
| `npm run check:two-process`        | Two API processes on one Redis: one quota, events and alerts relayed to each other's dashboards                                                                                                        | Three runs, each exit 0 in 3.9 to 4.0 s, with the output below and no API log line at error or warning level; 30 more runs in a row on the same tree, each exit 0 |
| `npm run check:population`         | One API with 1000 and then 10000 registered users: list, filter and analytics reads                                                                                                                    | Three runs, each exit 0 in 9.7 to 10.4 s; figures under [Reads by number of users](#reads-by-number-of-users)                                                     |
| `docker compose up --build --wait` | The image and Compose: both containers healthy                                                                                                                                                         | Exit 0 in 17.5 s, both services healthy; the application runs as the user `node`                                                                                  |

The integration runner prints totals and not one line per test. That a case
named below passed is concluded from 74 of 74 tests passing in every run with
none skipped.

Every line `npm run check:two-process` printed, apart from the API processes'
own logs and the line naming its Redis URL and ports, the same in all three
runs:

```
Both processes admitted against the same counter (99, 98 remaining)
200=100 429=100 other=0
One rate:limit_exceeded event, the same at the dashboards on both processes
Cross-process request event received
Cross-process reset event received
```

### Concurrent admission

One user, quota 100, 200 requests sent at once.

| Setup             | Admitted (200) | Rejected (429) | Other | Source                                                                                                                                                                                                                                                                 |
| ----------------- | -------------- | -------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One API process   | 100            | 100            | 0     | `apps/api/test/concurrency.e2e-spec.ts`, "admits exactly 100 of 200 concurrent requests, each with its own x-count", in all five integration runs. It also asserts that the 100 `x-count` values are 0 to 99, each once, and that Redis holds 100 entries for the user |
| Two API processes | 100            | 100            | 0     | Printed by `npm run check:two-process` in all three runs; the requests alternate between the two processes, and the check asserts 100 entries in Redis                                                                                                                 |

### A Redis that stops answering

In the integration runs Redis is reached through a TCP relay that is either
stopped (connections refused) or hung (connections open, nothing forwarded).
The first failing answer must arrive in under 5 s and each later one in under
0.5 s; these bounds are constants of `apps/api/test/support/application.ts`.
Every case passed in all five runs.

| Case                                                                                                           | Asserted                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outage.e2e-spec.ts`, "answers 503 within a bound while Redis is stopped, then serves again without a restart" | With a sample request arriving every 200 ms, a sample request and an admin reset both answer 503 within the first bound, then three more rounds within the later bound, without `x-count`. After the relay is restored the user list answers 200 within 8 s, a sample request answers 200 and a reset leaves `used` at 0 |
| `outage.e2e-spec.ts`, the same case "while Redis is hung"                                                      | The same, with the hung relay                                                                                                                                                                                                                                                                                            |
| `health.e2e-spec.ts`, "answers 200 while Redis answers"                                                        | `GET /api/health` answers 200 `{"status":"ok"}` without a credential                                                                                                                                                                                                                                                     |
| `health.e2e-spec.ts`, "answers 503 while Redis is stopped, and 200 once it is back"                            | 503 with the message "Redis is not reachable.", and 200 again within 8 s                                                                                                                                                                                                                                                 |
| `health.e2e-spec.ts`, "answers 503 within the bound while Redis is hung, and 200 once it answers"              | The first 503 within the first bound, three more within the later bound, and 200 again within 8 s                                                                                                                                                                                                                        |

The same was timed once by hand on the Compose application:
`docker compose pause redis`, one request every 200 ms to each route, then
`docker compose unpause redis`.

| Route             | First 503 after the pause                                    | That request took | The next four 503s took | First 200 after the unpause |
| ----------------- | ------------------------------------------------------------ | ----------------- | ----------------------- | --------------------------- |
| `GET /api/sample` | 3.81 s, "The rate limit store did not answer.", no `x-count` | 3617 ms           | 8, 6, 6 and 5 ms        | 0.11 s                      |
| `GET /api/health` | 3.81 s, "Redis is not reachable."                            | 3640 ms           | 10, 7, 4 and 3 ms       | 0.11 s                      |

```mermaid
xychart-beta
    title "GET /api/sample while Redis is paused: time to each 503"
    x-axis ["1st", "2nd", "3rd", "4th", "5th"]
    y-axis "Milliseconds" 0 --> 4000
    bar [3617, 8, 6, 6, 5]
```

The first request waits until the client gives the connection up, which the
[platform specification](specs/platform.md#behavior) puts at about 4 s; the
ones after it are refused at once. Neither container restarted: the restart
count stayed 0 and the start time stayed the same for both.

### Reads by number of users

`npm run check:population`, three runs. Each figure is taken over ten
sequential requests to one admin route, timed in the script from sending the
request to the parsed JSON body, while one sample request every 50 ms goes to
the same API. It is the time an admin client waits on one machine, not
admission latency and not a load test. "Page" is `GET /api/admin/users?page=10`,
"filter" is `?status=OK&search=user`, which matches every user and so reads
them all, and "analytics" is `GET /api/admin/analytics`. "Seed" is the time
to register users 1 to N in the script's own process; at 10000 it finds the
first 1000 present and adds 9000. "Redis memory" is `used_memory` of the whole
test server after the reads, the server's own baseline included.

| Run | Users | Seed     | Page, median / max | Filter, median / max | Analytics, median / max | Redis memory | Sample requests, all admitted |
| --- | ----- | -------- | ------------------ | -------------------- | ----------------------- | ------------ | ----------------------------- |
| 1   | 1000  | 52.4 ms  | 4.5 / 9.4 ms       | 25.7 / 138.1 ms      | 23.1 / 142.4 ms         | 2,746,960 B  | 13                            |
| 1   | 10000 | 319.1 ms | 2.9 / 4.1 ms       | 136.0 / 277.6 ms     | 128.2 / 139.3 ms        | 5,530,912 B  | 52                            |
| 2   | 1000  | 52.5 ms  | 3.8 / 7.6 ms       | 18.6 / 41.9 ms       | 16.8 / 24.1 ms          | 2,747,592 B  | 8                             |
| 2   | 10000 | 243.7 ms | 3.2 / 3.5 ms       | 129.6 / 315.6 ms     | 132.3 / 214.9 ms        | 5,538,744 B  | 54                            |
| 3   | 1000  | 54.0 ms  | 3.8 / 6.0 ms       | 18.1 / 24.2 ms       | 17.7 / 33.8 ms          | 2,745,128 B  | 8                             |
| 3   | 10000 | 358.4 ms | 2.7 / 3.3 ms       | 125.1 / 202.4 ms     | 124.6 / 147.7 ms        | 5,528,728 B  | 48                            |

An unfiltered page reads only its own rows and does not grow with the number
of users; a filtered page and the analytics read every registered user and
took about seven times as long at ten times the users. The medians are
charted in the [README](../README.md#verification).

## In a browser

One pass in Chromium against the Compose application at
http://127.0.0.1:3000, started with `docker compose up --build --wait` and
then given 1000 users with `npm run seed:users -- --count 1000`, which printed
`{"processed":1000,"added":988,"total":1000}`. Each observation was compared
with the admin API's answer to the same question where one exists. A
screenshot of every step was looked at; two of them are in the README and the
others are not kept.

| #   | Done                                                                                                   | Observed                                                                                                                                                                                                                                                                                                    | Result                  |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Signed in with a wrong token, then with `demo-admin-token`, each with Enter                            | "The admin token was not accepted.", then the dashboard with "LIVE"                                                                                                                                                                                                                                         | Pass                    |
| 2   | Read the table                                                                                         | The columns User ID, Remaining / Total, Reset Time, Status and Last Request; 12 rows before seeding, as the API reports                                                                                                                                                                                     | Pass                    |
| 3   | Sent one request as `user-01` with `curl` while the page was open                                      | The row went from 99 / 100 to 98 / 100 with a new last-request time, without a reload                                                                                                                                                                                                                       | Pass                    |
| 4   | Ran `node scripts/traffic.mjs http://127.0.0.1:3000` for 10 s                                          | Three users at OK, one at Warning (8 / 100) and one at Exceeded (0 / 100); the notification "Limit exceeded: user-06", "Retry at 18:00:00 UTC" appeared 1.3 s after the traffic started and closed after 5 s                                                                                                | Pass                    |
| 5   | Searched `user-1`, `USER-05` and `nobody`; chose each status and each "Last active" option             | 3, 1 and 0 rows; every filter showed the rows the API returns for the same query                                                                                                                                                                                                                            | Pass                    |
| 6   | With 1000 users: page sizes 25 and 100, Next, Previous, Last and First; a request as a user on page 2  | "Page 1 of 20 · 1000 matching users" at the default 50, then 40 pages at 25 and 10 at 100; pages 3 and 40 equal the API's; the row on page 2 changed 0.02 s after the request                                                                                                                               | Pass                    |
| 7   | Opened a user, sent a request as that user, switched the history to "Past day"                         | Usage, limit, extra, remaining, reset time, last reset, last request and suspension; 100 recent requests, as the API returns; the new request at the top of the list after 0.05 s; the chart and its totals changed with the range. The totals line changes at the next history read, not on the live event | Pass                    |
| 8   | On one user: reset, limit 5, suspend for 5 minutes, 7 requests, resume, 1 request, 10 extra, 1 request | Each action showed on the page and in the API. While suspended all 7 requests were admitted with `x-count` 4, 3, 2, 1, 0, 0, 0; after resuming the next one was a 429 "Rate limit of 5 requests per hour exceeded. Try again at 18:00:00 UTC."; after the extra grant the next one was admitted             | Pass                    |
| 9   | Set the limit to `0`, `20000` and `1.5`; then paused Redis and pressed "Reset usage"                   | Each value refused with "Enter an integer from 1 to 10000." and no request sent. With Redis paused the action showed "The rate limit store did not answer." after 3.3 s and its button was usable again; the load errors cleared about 3 s after the unpause, and a reset then succeeded                    | Pass                    |
| 10  | Read the analytics cards and `GET /api/admin/analytics` before and after                               | Total users 1000, near limit 22%, three 429s today and the same five top users in both                                                                                                                                                                                                                      | Pass                    |
| 11  | `docker compose restart app` with the page open, then a request as `user-09`                           | "DISCONNECTED, RECONNECTING…" after 0.23 s, "LIVE" again after 1.12 s, and the row equal to the API's without a reload                                                                                                                                                                                      | Pass                    |
| 12  | Hid the tab                                                                                            | Not checked: see [Not verified](#not-verified)                                                                                                                                                                                                                                                              | Not checked             |
| 13  | Keyboard only                                                                                          | Signed in with Enter, chose a status filter with the arrow keys, opened a user with Enter, added 3 extra requests from the form (the API's `extra` went from 0 to 3); Escape closed the panel and returned focus to the user's button                                                                       | Pass                    |
| 14  | Read the browser console over the whole pass                                                           | The 401 of the refused token and the 503s of the deliberate pauses, as expected. One warning is unexplained: "WebSocket is closed before the connection is established", in the session that first signed in with a wrong token. The page worked normally afterwards                                        | One warning unexplained |

Two smaller observations. With the detail panel open at this window size the
panel covers the table's Status and Last Request columns, which is why the
README shows two pictures. The page summary reads "1 matching users" for a
single match, following the pattern the dashboard specification gives.

The other run modes of the [README](../README.md#run-it):

| Mode            | Done                                                                                                                                           | Observed                                                                                                                                                              | Result                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Development     | `docker compose up -d redis`, `cp .env.example .env`, `npm run dev`; signed in at http://localhost:5173; one request as `user-01` to port 3000 | 12 rows and "LIVE"; the row changed 0.06 s after the request; an empty console                                                                                        | Pass                     |
| Dashboard alone | `VITE_FIXTURES=1 npm run dev -w apps/web` with nothing on port 3000                                                                            | The token form, which any token passes; then 12 fixture rows at OK, Warning and Exceeded, the cards and "LIVE"; no request to `/api` or `/socket.io` left the browser | Pass                     |
| One origin      | Not run by hand                                                                                                                                | The integration file `one-origin.e2e-spec.ts` serves the built page, the API and the socket from one process                                                          | Not checked in a browser |

## Requirements

Each item of [the requirements](REQUIREMENTS.md) and where it is shown. "T"
is `npm test`, "I" is `npm run test:integration`, "2P" is
`npm run check:two-process`, "P" is `npm run check:population`, "B" is the
browser pass above.

Files are named without their directory: `*.spec.ts` under `apps/api/src`, `*.e2e-spec.ts` under `apps/api/test`, `*.test.ts(x)` under `apps/web/src`. A file shows that a case exists; the result of running it is in the tables above.

| Requirement                                                                    | Shown by                                                                                                                                                                                  | Scope, and what is not shown                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Objective: rate limiting as a NestJS interceptor, in a concurrent environment  | `rate-limit/rate-limit.interceptor.ts`; `rate-limit.interceptor.spec.ts` (T); `concurrency.e2e-spec.ts` (I)                                                                               |                                                                                     |
| Backend 1: external storage, by user ID and not IP or MAC                      | `user-token.guard.spec.ts`, `rate-limit.store.spec.ts` (T); `admission.e2e-spec.ts`, `registry.e2e-spec.ts` (I)                                                                           | The ID comes from the bearer token; no address is read                              |
| Backend 2: NestJS                                                              | `apps/api/package.json`, `app.module.ts`; the build                                                                                                                                       |                                                                                     |
| Backend 3: 100 per hour, tracked externally, reset every hour                  | `admission.e2e-spec.ts`, `expiry.e2e-spec.ts` (I); `rate-limit.interceptor.spec.ts`, `keys.spec.ts` (T); 2P                                                                               | A fixed UTC hour, not a rolling window                                              |
| Backend 4: `x-count` on each successful request                                | `admission.e2e-spec.ts` (I); `rate-limit.interceptor.spec.ts` (T)                                                                                                                         |                                                                                     |
| Backend 5: concurrency-proof                                                   | `concurrency.e2e-spec.ts`, `store-races.e2e-spec.ts` (I); 2P                                                                                                                              | Bounded runs with one and two processes on one machine                              |
| Backend 6: 429 with a message and the time to try again                        | `admission.e2e-spec.ts` (I); `rate-limit.interceptor.spec.ts` (T)                                                                                                                         | The body's retry time and `Retry-After`                                             |
| Backend 7: unit tests with a mock library for the store                        | `rate-limit.interceptor.spec.ts`, `rate-limit.store.spec.ts`, with `vitest-mock-extended` (T)                                                                                             |                                                                                     |
| Frontend: React or Angular, TypeScript, a UI library                           | `apps/web/package.json` and the lockfile; the build                                                                                                                                       | React, TypeScript and Mantine at the versions the lockfile pins                     |
| Core 1: live user table over WebSocket, `@nestjs/websockets`, both events      | `live-events.e2e-spec.ts`, `alerts.e2e-spec.ts`, `cross-process.e2e-spec.ts` (I); `App.test.tsx`, `assembled.test.tsx`, `live/useLiveUsers.test.tsx` (T); 2P; B                           |                                                                                     |
| Core 2: user detail: stats, recent requests, last reset, event stream, history | `read-model.e2e-spec.ts` (I); `features/dashboard.test.tsx`, `assembled.test.tsx` (T); B                                                                                                  | The event list holds requests, not admin actions                                    |
| Core 3: reset, custom limit, temporary suspension, extra requests              | `admin-behavior.e2e-spec.ts`, `admin-http.e2e-spec.ts`, `expiry.e2e-spec.ts` (I); `features/admin/AdminForms.test.tsx`, `features/dashboard.test.tsx` (T); B                              |                                                                                     |
| Core 4: search by user ID, status filter, last-active filter                   | `registry.e2e-spec.ts`, `read-model.e2e-spec.ts` (I); `user-reads.spec.ts`, `features/table/UsersTable.test.tsx`, `api/fixture-client.test.tsx` (T); B                                    | Exactly 90% is Warning                                                              |
| Core 5: total users, percent near the limit, today's 429s, top users           | `read-model.e2e-spec.ts`, `registry.e2e-spec.ts` (I); `analytics.spec.ts`, `features/dashboard.test.tsx` (T); B                                                                           |                                                                                     |
| Submission: `package.json` with dependencies and scripts                       | `npm ci`, `npm run build`, `npm run lint`, `npm test` from a fresh checkout                                                                                                               |                                                                                     |
| Submission: a ZIP file or a link to a GitHub repository                        | This repository                                                                                                                                                                           | Sending it is the owner's step and is not claimed here                              |
| Submission: commented code and good practices                                  | [Coding rules](CODING-RULES.md), enforced in part by lint                                                                                                                                 | A judgement for the reviewer; no test shows it                                      |
| Expectation: every significant decision backed by reasoning and trade-offs     | [Decisions](../README.md#decisions) in the README, which links the 23 decisions of the five specifications, each with its alternatives and cost                                           | Whether the reasoning convinces is the reviewer's judgement                         |
| Expectation: engineering thought process                                       | The specification-first trail: a specification commit before the code in each pull request, the test plans, the review fixes in the history, and this record                              | A judgement for the reviewer                                                        |
| Expectation: architecture                                                      | The decisions of the five specifications; the build; I; 2P                                                                                                                                |                                                                                     |
| Expectation: scalability                                                       | 2P; P; `registry.e2e-spec.ts` (I)                                                                                                                                                         | Two processes and 10000 users on one machine; filters and analytics read every user |
| Expectation: performance                                                       | `concurrency.e2e-spec.ts` ("answers another user within a second each while 1000 rejections arrive") (I); P                                                                               | No throughput or admission-latency figure was measured                              |
| Expectation: reliability                                                       | `redis.module.spec.ts`, `redis-io.adapter.spec.ts`, `health.controller.spec.ts` (T); `outage.e2e-spec.ts`, `health.e2e-spec.ts`, `cross-process.e2e-spec.ts` (I); the Compose pause above | One Redis; no failover, no restart with lost data                                   |
| Expectation: security                                                          | `config.spec.ts`, `user-token.guard.spec.ts`, `admin.controller.spec.ts` (T); `admin-http.e2e-spec.ts`, `registry.e2e-spec.ts`, `live-events.e2e-spec.ts` (I)                             | Demo tokens, no TLS                                                                 |
| Expectation: maintainability                                                   | The shared contract package, lint, `npm run check:contracts`, the coding rules                                                                                                            | A judgement for the reviewer                                                        |
| Expectation: ready for production                                              | Not shown                                                                                                                                                                                 | Demo credentials, one Redis without failover, no TLS, no load test                  |

## Pitfalls

Each item of [the pitfalls](PITFALLS.md) was checked against the code at
`cddeba2`: its guard was found, the fault was looked for, and where a small
edit could remove the guard, the edit was made and the item's check was run.
None of the 33 faults was found. Two defects that the list did not name were
found and fixed:

- The dashboard dropped a `rate:limit_exceeded` alert when a snapshot holding
  the same version of the row arrived before the event (pull request #19).
  It was reproduced in the dashboard's tests, not against a running API.
- Two API processes started together on an empty Redis could each refuse the
  `DEMO_USERS` the other had just registered, and one stopped.
  `npm run check:two-process` failed 5 times in 30 before the fix and 0 times
  in 30 after it (pull request #20). The three passing runs recorded earlier
  were too few to show it.

Eight checks passed with their guard removed (P8, P9, P16, P18, P21, P25, P26
and P28). Pull request #19 added an assertion to each, and each was seen to
fail without the guard.

What the checks do not show:

- P5: only the mocked-store test notices an expiry set outside the
  transaction.
- P7: the latency case notices a lock held 50 ms for each request, not one
  held 10 ms.
- P22: two checks drop a late 401, and each hides the removal of the other.
- P31 and P32 are rules for people; nothing automated enforces them.
- P33: no automated check of contrast. Measured once by hand in Chromium, the
  status badges had ratios of 6.39 to 11.28 against a minimum of 4.5.

## Not verified

- A hidden tab in a real browser. Three ways of hiding the page (another tab
  in front, headless and with a window, and a minimized window) left
  `document.visibilityState` at "visible", so the pause while hidden and the
  read on becoming visible were not observed. They are covered only in jsdom,
  by `live/useLiveUsers.test.tsx`, "ticks every 10 seconds while visible,
  pauses while hidden, and reconciles on visibility".
- The "One origin" run mode in a browser, and the `npm run demo:traffic`
  alias: the traffic was sent with `node scripts/traffic.mjs` and a base URL.
- A request sent in the instant the API process was down during its restart.
  The request of item 11 went out after the API answered again and before the
  page had reconnected.
- "Last 24 hours" against "Last hour" in the browser: all activity lay within
  the hour, so both showed the same users.
- The cause of the WebSocket warning of item 14.
- Any browser other than Chromium.
- Sustained load, more than one host, TLS, a Redis failover, and the wait on
  `SIGTERM` of the platform specification.
