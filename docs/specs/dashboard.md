# Dashboard

## Scope

The admin page in the browser: session, API client with shape checks, live user
state, the fixture mode that runs it without an API, and the header that shows
the connection. It applies, and does not define,
[rate limiting](rate-limiting.md#behavior), [admin API](admin-api.md#behavior)
and [live updates](live-updates.md#behavior).

## Behavior

1. **Session.** A field labelled "Admin token", described as demo
   authentication, comes first; nothing is requested before a token is entered.
   The token stays in `sessionStorage` (memory if blocked) until the tab
   closes; no sign-out. A 401 or a refused handshake forgets it and returns to
   the field with "The admin token was not accepted." (Expectation: security)
2. **Requests.** Same origin, bearer token, 10-second limit, never repeated by
   the page ([P17]). A cancelled request is silent; any other failure shows a
   message. A response, event or 401 arriving after its session ended changes
   nothing ([P22]). (Expectation: reliability; Expectation: security)
3. **Shape checks.** A response or socket event that does not match its
   `packages/contracts` type is not used: a bad response fails with "The server
   returned an invalid response."; a bad event is ignored whole, with no row,
   recent request, alert or update time. The browser never computes remaining,
   total or status ([P3]). (Expectation: reliability; Expectation: security)
4. **Live state.** One hook per session owns the socket and rows and applies
   events and snapshots as [live updates](live-updates.md#behavior) orders;
   events cause no request and unmounting removes only its own listeners
   ([P21]). The header shows "Connecting…", "Live" or "Disconnected,
   reconnecting…" and, apart, "Last update HH:MM:SS UTC" or "No update yet"
   ([P20]). An accepted `rate:limit_exceeded` also shows a red notification,
   "Limit exceeded: <id>", with "Retry at HH:MM:SS UTC", for 5 seconds.
   (Core feature 1; Expectation: reliability)
5. **Fixture mode.** With `VITE_FIXTURES=1` in development no API is needed:
   any token opens the page, data answers after 150 ms, a stand-in socket
   connects, sends `rate:update` at 2 and 4 s and `rate:limit_exceeded` at 6 s,
   and actions only raise a version. A production build holds none of it;
   `npm run check:contracts` fails if the data breaks its rules.
   (Expectation: maintainability)

## Interface

Consumes the routes of [admin API](admin-api.md#interface), the events of
[live updates](live-updates.md#interface) and `packages/contracts` types. Vite
serves port 5173 and forwards `/api` and `/socket.io` to the API, so calls are
relative; the built page is served as [platform](platform.md#behavior) says.
Defines the `sessionStorage` key `adminToken` and `VITE_FIXTURES` (development
server only; `1` selects fixtures).

## Decisions

- **UI library: Mantine.** One family covers forms, alerts and notifications.
  MUI, Ant Design, shadcn/ui and Chakra were compared from general knowledge.
- **Shape checks written by hand.** `packages/contracts` holds types only, so
  a schema library adds a dependency and a second definition of every payload;
  the guards in `api/validation.ts` restate them too, more cheaply. Cost: a
  field a guard omits goes unnoticed, relations (remaining against total) are
  unchecked, and the compiler compares only a guard's lists of union members
  with its type. Shown by `api/client.test.ts`, `live/useLiveUsers.test.tsx`.
- **Live state in one hook, no state library.** Events and snapshots arrive in
  any order, so `useLiveUsers` owns rows and the snapshot queue; a query
  library would not order them and adds a dependency. Shown by
  `live/useLiveUsers.test.tsx`, `live/rows.test.ts`.
- **Fixture mode.** Screens had to be reviewable without Redis: fixtures sit
  behind a development-only import, with no mock server. Cost: data can drift,
  hence `fixtures/check.ts`.

## Test plan

Vitest in jsdom (`npm test -w apps/web`), paths under `apps/web/src/`:

- `api/client.test.ts`: bearer token, encoded ID; a 401 reported once, a late
  one dropped; malformed body; timeout; method, path and body of each route.
- `live/rows.test.ts`: version and window ordering.
  `live/useLiveUsers.test.tsx`: snapshot on connect; a newer event beats a slow
  snapshot; coalescing; visible-only ticks; no request for events; a malformed
  event ignored; cleanup.
- `lib/latestRequests.test.ts`: last copy wins, newest first, cap of 100.
  `fixtures/check.ts` runs as `npm run check:contracts`.

## Milestone

`npm run check:contracts` ends `fixtures consistent: <n> checks passed`;
`npm test -w apps/web` reports no failure. Then:

1. `VITE_FIXTURES=1 npm run dev -w apps/web`, open http://localhost:5173, enter
   any token, press "Open dashboard": "Live"; "Last update" reads 10:42:00 UTC,
   then 10:42:01, :02, :03 at 2, 4 and 6 seconds; at 6 seconds "Limit exceeded:
   user-05" and "Retry at 11:00:00 UTC" show for 5 seconds.
2. `cp .env.example .env`, `docker compose up -d redis`, `npm run dev`, same
   address: a wrong token returns to the field with "The admin token was not
   accepted."; `demo-admin-token` gives "Live" and a "Last update" time.

## Limits

jsdom is not a browser: layout and real focus are unproven. The token is a
shared demo credential any script of the page can read. The notification
lifetime is untested.

[P3]: ../PITFALLS.md#p3-a-status-threshold-that-only-works-for-round-limits
[P17]: ../PITFALLS.md#p17-retrying-an-admin-action-automatically
[P20]: ../PITFALLS.md#p20-taking-a-connection-for-delivery
[P21]: ../PITFALLS.md#p21-removing-another-components-listeners
[P22]: ../PITFALLS.md#p22-applying-a-response-without-checking-what-it-was-for

