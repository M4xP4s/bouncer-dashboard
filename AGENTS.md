# bouncer-dashboard — agent instructions

## What this is

A per-user rate limiter (NestJS interceptor, shared state in Redis) and a live
administration dashboard (React, TypeScript, WebSockets).

[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) is the source of truth for what
must be built. It has two parts: the base requirements from the assignment
brief, and additional expectations that the solution be production-minded and
that every significant decision come with its reasoning and trade-offs.

Read [the documentation map](docs/README.md) before writing code or
documents. It defines the specification template and the one place where each
kind of fact is written. Read [the pitfalls](docs/PITFALLS.md) before
designing or changing a capability, and cite their IDs in reviews.

## How work is done

- Follow the specification-first process in
  [the documentation map](docs/README.md#specifications). Do not commit to
  `main`.
- Run [the requirements check](docs/README.md#requirements-check) at each
  of its three points: before a specification commit, before opening a pull
  request and before a milestone tag. On a deviation, fix the code or stop
  and ask the owner; do not document it away.
- Base requirements are implemented before improvements.
- Every commit builds, lints and passes the tests that exist at that commit.
- Open a pull request and wait for the owner's review. Merge only when the
  owner says so, with a merge commit and no squash.

## Rules

- This repository is public. Never commit secrets: `.env` stays ignored and
  `.env.example` holds placeholders only.
- Do not name the company that issued the assignment or anyone involved in the
  hiring process, in code, comments, documents, commit messages or branch
  names. Correspondence, call notes and preparation material stay out.
- Treat the base requirements as fixed text. Where a requirement is
  ambiguous, state the chosen reading as an interpretation in the
  specification instead of editing the requirement.
- Each fact has one authoritative definition, listed in
  [the documentation map](docs/README.md#one-definition-per-fact). Mention,
  summarize or link to it elsewhere; do not define it a second time or
  contradict it.
- A pitfall is described by a short text, a snippet written for the document
  or a diagram. It never says where the fault was observed and never
  contains code taken from another project. A pitfall about something this
  repository does not build is left out.
- Add diagrams freely, following
  [the diagram rules](docs/README.md#diagrams): Mermaid for sequences,
  Excalidraw PNGs for overviews, also in READMEs.
- Do not claim scalability, production readiness or a passing check without
  evidence produced from this repository. State what was not verified.
- Prefer the smallest complete solution. Add a service or dependency only for
  a concrete requirement.
- Keep the code well commented, as the submission guidelines ask.
