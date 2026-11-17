# Coding rules

Rules for readable code, collected from the reviews of this repository's pull
requests. Each one fixes a pattern a reviewer had to send back. Cite the IDs
in reviews.

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
| S2 | Build a response body or message in its own function, outside the main flow. |
| S3 | Two methods with the same `try`/`catch` share one helper. |
| S4 | Trust the types. Drop a check the types or the data already rule out. |

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

Tests keep literal values on purpose: they check the exact values sent, so a
constant changed by mistake fails them.

## Formatting

| ID | Rule |
| --- | --- |
| P1 | Every changed TypeScript file passes `prettier --check`. |
