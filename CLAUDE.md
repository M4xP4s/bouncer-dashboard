# bouncer-dashboard — project instructions

## What this is

A per-user rate limiter (NestJS interceptor, shared state in Redis) and a live
administration dashboard (React, TypeScript, WebSockets).

[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) is the source of truth for what
must be built. It has two parts: the base requirements from the assignment
brief, and additional expectations that the solution be production-minded and
that every significant decision come with its reasoning and trade-offs.

## Status

Initialized with the requirements only. The implementation is imported from a
private development repository. When it lands, add the layout and the exact
run, check and test commands here; do not document a command before it exists
in this repository.

## Rules

- This repository is public. Never commit secrets: `.env` stays ignored and
  `.env.example` holds placeholders only.
- Do not name the company that issued the assignment or anyone involved in the
  hiring process, in code, comments, documents, commit messages or branch
  names. Correspondence, call notes and preparation material stay out.
- Treat the base requirements as fixed text. Record an interpretation of an
  ambiguous requirement as a design decision instead of editing the
  requirement.
- Record each significant architecture, stack, behavior or testing decision
  with the alternatives considered, the trade-off and the reason for the
  choice.
- Do not claim scalability, production readiness or a passing check without
  evidence produced from this repository. State what was not verified.
- Prefer the smallest complete solution. Add a service or dependency only for
  a concrete requirement.
- Keep the code well commented, as the submission guidelines ask.
- Commit and push only when asked.
