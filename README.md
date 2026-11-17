# bouncer-dashboard

A per-user API rate limiter built as a NestJS interceptor, with a live React and TypeScript dashboard for administering it. Shared quota state lives in Redis so several API processes enforce one limit; changes reach the dashboard over WebSockets.

## Status

This repository currently holds the requirements only. The implementation is being moved in from a private development repository.

## Requirements

[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) contains the assignment brief the project is built against, followed by the additional expectations on production readiness and documented design reasoning.

## AI use

AI assistants helped plan, implement, review and test this project. Agent instructions are in [CLAUDE.md](CLAUDE.md).
