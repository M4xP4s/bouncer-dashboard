# Documentation

How this project is specified, and where each kind of fact is written down.

## Reading order

| Step | Document | Answers |
| --- | --- | --- |
| 1 | [REQUIREMENTS.md](REQUIREMENTS.md) | What was asked. Fixed text; it is never edited. |
| 2 | `specs/NN-name.md` | What the system does and why. One per pull request, written before its code. |
| 3 | Source code and `packages/contracts` | How. Comments explain why a line exists, not what it does. |
| 4 | `VERIFICATION.md` | What was shown to work: dated results and what was not checked. |

The [README](../README.md) is the entry point: overview and commands.

## One home per fact

Every fact is written in one place. Other documents link to it and do not
repeat it, so a change is made once and nothing can drift apart.

| Fact | Its only home |
| --- | --- |
| What the brief asks | [REQUIREMENTS.md](REQUIREMENTS.md) |
| A behavior rule, or the reading chosen for an ambiguous requirement | **Behavior** in the owning specification |
| A decision, the alternatives considered and its cost | **Decisions** in the owning specification |
| Routes, events and storage keys | **Interface** in the owning specification |
| Payload fields and their meaning | The type's comment in `packages/contracts` |
| Configuration variables | Comments in `.env.example` |
| Commands | The [README](../README.md) |
| Results of checks | `VERIFICATION.md` |
| Rules for coding agents | [CLAUDE.md](../CLAUDE.md) |

A topic belongs to the specification of the pull request that implements it.
There is no separate decision log and no separate reference document.

## Specifications

Work reaches `main` through pull requests. The first commit of a pull request
is its specification; the implementation commits follow and must agree with
it. If the implementation shows the specification to be wrong, the
specification is corrected in the same pull request, so the change of mind
stays visible.

Each specification has the same six sections:

| Section | Content |
| --- | --- |
| Scope | What the pull request delivers, and which requirement items or additional expectations it covers. |
| Behavior | Numbered rules, each one testable. A rule that settles an ambiguity in the brief is marked **Interpretation** and quotes the ambiguous words. |
| Interface | Routes, events and storage keys. Payloads are named by type and not repeated. |
| Decisions | Each significant choice: the alternatives, the reason for the choice and what it costs. |
| Test plan | The cases to write and where each runs: against a mocked store, a real store or a browser environment. |
| Limits | What this part does not do and does not prove. |

### Index

Specifications are listed here as their pull requests are merged.
