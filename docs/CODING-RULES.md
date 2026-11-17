# Coding rules

Rules for readable, reliable code, drawn from repository reviews and the
framework guidance linked below. Cite the IDs in reviews. These are house
rules; application behavior remains defined in the owning specification.

## Comments

| ID | Rule |
| --- | --- |
| C1 | One or two lines. Say why the line exists, not what it does. |
| C2 | No comment that repeats the name, the code or the specification. Delete it. |
| C3 | No comment about code that does not exist yet. |
| C4 | Do document a return value whose meaning the name does not give. |

```ts
// Before (C2): restates the class.
/** The configuration module: provides the configuration. */

// After (C4): the boolean is not "bookkeeping succeeded".
/** Returns true when this rejection claims the notification flag. */
```

## Control flow

| ID | Rule |
| --- | --- |
| F1 | No `else if` ladders. Move the checks into a named helper that returns early. |
| F2 | No nested ternaries. A decision between three outcomes is a helper with guard clauses. |
| F3 | A ternary whose branch spans several lines becomes an `if`. |
| F4 | A one-line guard stays on one line: `if (!(error instanceof X)) throw error;`. |
| F5 | Catch only the failure you handle and rethrow the rest. |

```ts
// Before (F1): three checks and two writes in one ladder.
if (badFormat) problems.push(`${where} must be userId:token`);
else if (userIds.has(userId)) problems.push(`${where} repeats a user ID`);
else { userIds.add(userId); userIdByToken.set(token, userId); }

// After: the helper names the check; the loop only applies the result.
const problem = demoUserProblem(entry, userIds, userIdByToken, adminToken);
if (problem) {
  problems.push(`DEMO_USERS entry ${index + 1} ${problem}`);
  return;
}
userIds.add(userId);
userIdByToken.set(token, userId);
```

```ts
// Before (F2, F3): a nested ternary, then a five-value tuple rebuilt inline.
const row =
  outcome === 'denied'
    ? buildRow(userId, [count - 1, limit, extra, suspend, hash], now)
    : counted;

// After: one helper decides, another builds the changed input.
let row = buildRow(userId, rowReplies, now);
const outcome = outcomeFor(row);
if (outcome === 'denied') {
  row = buildRow(userId, withoutRequest(rowReplies), now);
}
```

## Functions

| ID | Rule |
| --- | --- |
| S1 | A function that classifies, normalizes and formats is split into named steps. The top-level function reads as those steps. |
| S2 | Extract response or message construction when it contains meaningful transformation or obscures the main flow. A simple object can stay inline. |
| S3 | Share error handling when the failure meaning and recovery policy are the same. Matching `try`/`catch` syntax alone is insufficient. |
| S4 | After boundary validation, trust the established type inside trusted code. Keep deliberate safety checks for framework wiring that the types cannot guarantee. |
| S5 | A function has at most 50 lines, not counting blank lines and comments; lint enforces it. Test files are exempt, because a `describe` callback is one function that holds many tests. |

```ts
// S1: the filter's catch() is three named steps.
const { statusCode, payload } = this.describe(error);
const envelope = {
  ...body,
  statusCode,
  error: errorNameOf(body, label),
  message: messageOf(body, label),
};

// S4: no configured token is empty, so the lookup needs no ternary.
const token = bearerToken(request.headers.authorization) ?? '';
const userId = this.config.userIdByToken.get(token);
```

S4 also preserves the interceptor's nonempty `userId` check: the request
type cannot guarantee that the route installed its authentication guard.

## Names and values

| ID | Rule |
| --- | --- |
| N1 | A name says what the value holds: `windowKey`, not `window`; `rowIncludingRequest`, not `counted`. |
| N2 | No bare numbers. Name a limit, a TTL or a threshold as a constant, with its unit in the name (`HISTORY_TTL_SECONDS`). |
| N3 | Derive units from each other: `MINUTE_MS = 60 * SECOND_MS`, not `60_000`. |
| N4 | Keep a value next to what it bounds: retention constants live beside the keys they expire. |
| N5 | Tie a count to the type it counts: `ROW_REPLY_COUNT: RowReplies['length'] = 5`, so the compiler catches a mismatch. |
| N6 | Use the framework's constants: `HttpStatus.TOO_MANY_REQUESTS`, not `429`. |
| N7 | Name an opaque expression: `clockTime(iso)`, not `iso.slice(11, 19)`. |
| N8 | Extract repeated lookups and opaque calculations before a returned object literal. Simple expressions can stay inline. |
| N9 | A boolean is named for what it allows (`shouldNotify`), not for the case that usually produces it (`firstRejection`). |

## TypeScript boundaries and state

| ID | Rule |
| --- | --- |
| TS1 | Validate untrusted input at its owning boundary: HTTP, WebSocket and configuration. A store reply may be asserted to its command's documented return type. A stored payload from trusted application writers may be asserted to the shape this application writes while the stored schema stays compatible, with a comment naming that invariant; otherwise validate or migrate it at the boundary. An annotation, assertion or generic parameter is not runtime validation; do not repeat established checks downstream (S4). |
| TS2 | Prefer `unknown` to `any` for untrusted values and narrow before use. Do not use type assertions or non-null assertions merely to silence an error. |
| TS3 | Use a discriminated union when independent optional fields would allow invalid combinations of mutually exclusive states. |

The [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
explains why assertions cannot establish a runtime guarantee.

## Asynchronous work and resources

| ID | Rule |
| --- | --- |
| A1 | Await or return work required for an operation's result. Deliberate background work must handle rejection explicitly; `void` alone does not handle it, and adding a rejection handler does not wait for completion. |
| A2 | Do not pass an async callback to an API that ignores its returned promise, such as `forEach`. Use sequential iteration or explicitly awaited concurrency; bound concurrency when the input can grow. |
| A3 | Keep request and socket handlers free of synchronous I/O and unbounded CPU work. Declaring a function `async` does not make its CPU work nonblocking. |
| A4 | Give every timer, listener, subscription and connection one cleanup owner, including partial startup failure and shutdown. Remove only the callbacks that owner registered; a consumer must not close a borrowed resource. |

[P15](PITFALLS.md#p15-answering-before-the-write-has-settled) illustrates A1,
and [P21](PITFALLS.md#p21-removing-another-components-listeners) illustrates A4.
[Node.js explains the event-loop cost](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
behind A3.

The API lint run enforces
[`no-floating-promises`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html)
with type-aware linting.
[`no-misused-promises`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-misused-promises.html)
is not enabled, and the web lint run is not type-aware, so A2 and all web
promise handling are checked in review. The default `ignoreVoid: true`
of `no-floating-promises` permits a bare `void`, so a passing lint run
alone does not prove A1. These rules do not prove that required writes settle
before a response; that needs the behavior checks in the owning specification.

## NestJS responsibilities and lifetime

| ID | Rule |
| --- | --- |
| NE1 | Keep request-specific values in local variables or pass them explicitly. Never store the current user, request or admission result in a singleton provider's fields. |
| NE2 | Inject shared clients and validated configuration through providers. Follow A4: only the designated lifecycle owner closes a shared client; consumers that merely borrow it do not. |
| NE3 | Use guards for authentication and authorization, pipes for transport input validation, interceptors for request/response interception, and filters for exception translation. Keep transport handlers focused on orchestration. |
| NE4 | Check lifecycle ordering before relying on another component's work. Interceptor pre-handler code runs after guards but before parameter pipes; it cannot assume those pipes have validated its input. |

Providers are [singletons by default](https://docs.nestjs.com/fundamentals/injection-scopes).
Use request scope only for a concrete lifetime requirement. The
[request lifecycle](https://docs.nestjs.com/faq/request-lifecycle) defines the
ordering in NE4.

## Tests

| ID | Rule |
| --- | --- |
| T1 | Tests keep literal values: they check the exact values sent, so a constant changed by mistake fails them. |
| T2 | No `as never` or `as SomeType` on a fixture. Build a complete typed value, or configure the mock. |
| T3 | Restore spies at file scope, so every test cleans up, not only one group. |

## Formatting

| ID | Rule |
| --- | --- |
| FMT1 | Every changed TypeScript file passes `prettier --check`. |
