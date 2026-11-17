# Documentation

How this project is specified, and where each kind of fact is defined.

## Reading order

| Step | Document | Answers |
| --- | --- | --- |
| 1 | [REQUIREMENTS.md](REQUIREMENTS.md) | What was asked: the brief and the quality expectations. Fixed text; it is never edited. |
| 2 | `specs/<capability>.md` | What the system does and why. Written or updated before the code it describes. |
| 3 | Source code and `packages/contracts` | How. Comments explain why a line exists, not what it does. |
| 4 | `VERIFICATION.md` | What was shown to work: dated results and what was not checked. |

The [README](../README.md) is the entry point: overview and commands.

## One definition per fact

Every fact has one authoritative definition. Other documents may mention it,
give an example, summarize it briefly or link to it. They do not define it a
second time and they do not contradict it, so a change is made in one place.

| Fact | Defined in |
| --- | --- |
| What was asked | [REQUIREMENTS.md](REQUIREMENTS.md) |
| A behavior rule, or the reading chosen for an ambiguous requirement | **Behavior** in the owning specification |
| A decision, the alternatives considered and its cost | **Decisions** in the owning specification |
| Routes, events and storage keys | **Interface** in the owning specification |
| Payload fields and their meaning | The type's comment in `packages/contracts` |
| Configuration variables | Comments in `.env.example` |
| Commands | The [README](../README.md) |
| Results of checks | `VERIFICATION.md` |
| Rules for coding agents | [AGENTS.md](../AGENTS.md) |

There is no separate decision log and no separate reference document: a topic
is defined in the specification of the capability it belongs to.

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
- **Short.** Aim for 60 to 120 lines per capability. A section with nothing
  to say is left out. When a specification grows, remove implementation
  inventory before splitting it.

| Section | Content |
| --- | --- |
| Scope | What the capability covers, and which requirement items or expectations it answers. |
| Behavior | Numbered rules, each one testable. A rule that settles an ambiguity in the brief is marked **Interpretation** and quotes the ambiguous words. |
| Interface | Routes, events and storage keys. Payloads are named by type and not redefined. |
| Decisions | Each significant choice, in a few sentences: what was asked, what follows from it, the mechanism chosen, the alternatives and their cost, and which test-plan cases are meant to show it. |
| Test plan | The cases to write and where each runs: against a mocked store, a real store or a browser environment. |
| Limits | What this capability does not do and does not prove. |

### Index

Specifications are listed here as their pull requests are merged.

### Quality navigation

The additional expectations name six qualities: architecture, scalability,
performance, reliability, security and maintainability. A table here will
link each one to the specification sections that address it. It contains
links only and is filled in as the specifications are written.
