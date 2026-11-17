# Documentation

How this project is specified, and where each kind of fact is defined.

## Reading order

| Step | Document | Answers |
| --- | --- | --- |
| 1 | [REQUIREMENTS.md](REQUIREMENTS.md) | What was asked: the brief and the quality expectations. Fixed text; it is never edited. |
| 2 | [PITFALLS.md](PITFALLS.md) | What is known to go wrong in a system like this one. Read before designing. |
| 3 | `specs/<capability>.md` | What the system does and why. Written or updated before the code it describes. |
| 4 | Source code and `packages/contracts` | How. Comments explain why a line exists, not what it does. |
| 5 | `VERIFICATION.md` | What was shown to work: dated results and what was not checked. |

The [README](../README.md) is the entry point: overview and commands.
[NOT-DOING.md](NOT-DOING.md) gathers what the project leaves out on purpose;
each of its rows links to the decision or limit that defines it.

## One definition per fact

Every fact has one authoritative definition. Other documents may mention it,
give an example, summarize it briefly or link to it. They do not define it a
second time and they do not contradict it, so a change is made in one place.

| Fact | Defined in |
| --- | --- |
| What was asked | [REQUIREMENTS.md](REQUIREMENTS.md) |
| A failure mode and a short example of a check that would catch it | [PITFALLS.md](PITFALLS.md) |
| Planned verification cases | **Test plan** in the owning specification |
| A behavior rule, or the reading chosen for an ambiguous requirement | **Behavior** in the owning specification |
| A decision, the alternatives considered and its cost | **Decisions** in the owning specification |
| Routes, events and storage keys | **Interface** in the owning specification |
| Payload fields and their meaning | The type's comment in `packages/contracts` |
| Configuration variables | Comments in `.env.example` |
| Commands | The [README](../README.md) |
| Results of checks | `VERIFICATION.md` |
| Rules for coding agents | [AGENTS.md](../AGENTS.md) |
| Coding rules | [CODING-RULES.md](CODING-RULES.md) |

There is no separate decision log and no separate reference document: a topic
is defined in the specification of the capability it belongs to.

## Requirements check

The requirements are fixed, and the work is compared with them at three
set points. Each time the items are re-read in
[REQUIREMENTS.md](REQUIREMENTS.md) itself, not recalled and not taken from a
specification's summary of them.

| When | What is compared | Where the result is written |
| --- | --- | --- |
| Before a specification commit | Every behavior rule against the item it cites. A rule that settles an ambiguity is marked **Interpretation**; a rule that departs from a clear item is not allowed. | The specification |
| Before a pull request is opened | The items the pull request touches against its code, its tests and what the running system shows. | A "Requirements check" list in the pull request description: each item, and "met", "not yet" or "deviates" |
| Before a milestone tag | Every numbered item of the brief and every additional expectation against the repository as a whole. | `VERIFICATION.md` |

A deviation is never left standing and never explained away in a document.
The code is brought back to the requirement, or the work stops and the owner
decides. Adding something the brief does not ask for is allowed only when it
changes nothing the brief does ask for, and it is labelled as an addition.

## Diagrams

Use a diagram wherever it explains something faster than a paragraph, in a
README, a specification or the pitfalls.

- **A sequence or an interleaving:** a Mermaid block in the document. It is
  text, so a review shows what changed.
- **An overview or an architecture picture:** an Excalidraw drawing exported
  as a PNG to `docs/images/`, with alternative text that says what it shows.
- A diagram illustrates a fact that the text defines. If the two disagree,
  the text is right and the diagram is redrawn.

## Specifications

There is one specification per capability, not per pull request. Each is a
stable document that grows as the capability does.

- **Specification before code.** Code for a topic lands only after the owning
  specification describes it. A pull request that changes behavior opens with
  the commit that adds or edits the specifications it touches; the
  implementation commits follow and must agree with them. If the
  implementation shows a specification to be wrong, it is corrected in the
  same pull request, so the change of mind stays visible.
- **Requirements include the quality expectations.** A rule cites the item it
  answers: a numbered item of the brief or one of the additional
  expectations.
- **Plan and evidence stay apart.** A specification states rules and a test
  plan and links to results. It never says that a planned case has passed.
  `VERIFICATION.md` records the date, the revision, the result and the
  limits, and only for checks run in this repository.
- **A specification is a milestone.** It ends in something a reviewer, human
  or agent, can verify without reading the code: a command and the output it
  must produce, or a screen and what it must show. Every behavior rule is
  reachable from a test-plan case or a milestone step. A rule is worded so
  that it can be checked; required behavior that cannot yet be verified is
  recorded as a gap, not dropped.
- **Short.** Aim for about 200 lines per capability, prose wrapped at 80
  columns. A section with nothing to say is left out. When a specification
  grows, remove implementation inventory before splitting it.

| Section | Content |
| --- | --- |
| Scope | What the capability covers, and which requirement items or expectations it answers. |
| Behavior | Numbered rules, each one testable. A rule that settles an ambiguity in the brief is marked **Interpretation** and quotes the ambiguous words. |
| Interface | Routes, events and storage keys. Payloads are named by type and not redefined. |
| Decisions | Each significant choice under a heading of its own, so that it can be linked, in a few sentences: what was asked, what follows from it, the mechanism chosen, the alternatives and their cost, and which test-plan cases are meant to show it. |
| Test plan | The cases to write and where each runs: against a mocked store, a real store or a browser environment. |
| Milestone | How to see that the capability works: the commands to run and their expected result, and for anything visible the steps in the browser and what appears. Written so that a person or an agent can follow it literally. |
| Limits | What this capability does not do and does not prove. |

### Index

Specifications are listed here as they are introduced.

| Specification | Covers |
| --- | --- |
| [Platform](specs/platform.md) | The workspace, start-up configuration, who a caller is, the user registry, the Redis connection, the health route, the error response and the run modes. |
| [Rate limiting](specs/rate-limiting.md) | UTC windows, atomic admission, quota headers and errors. |
| [Live updates](specs/live-updates.md) | Authenticated socket events, versioning, alert suppression and delivery across API processes. |
| [Admin API](specs/admin-api.md) | Authenticated actions, the paged user list, snapshots, activity history and analytics. |
| [Dashboard](specs/dashboard.md) | The admin page: session, checked API client, live user state, fixture mode, the table with search and filters, user detail and history, admin controls and analytics cards. |

### Quality navigation

The additional expectations name six qualities: architecture, scalability,
performance, reliability, security and maintainability. The
[README](../README.md#where-each-quality-is-addressed) links each one to the
decisions and limits that address it.
