# bouncer-dashboard

A per-user API rate limiter built as a NestJS interceptor, with a live React and TypeScript dashboard for administering it. Shared quota state lives in Redis so several API processes enforce one limit; changes reach the dashboard over WebSockets.

## How this repository is built

The project was developed in a private repository, specification first, with AI assistants. It is replayed here as a sequence of pull requests so that the order of work can be reviewed:

- Each pull request follows the [specification-first process](docs/README.md#specifications).
- The base requirements come first. Improvements are added on top of them afterwards.
- Commit dates are those of the replay, not of the original development.

The replay is in progress; the merged pull requests show how far it has come.

## Documentation

- [Requirements](docs/REQUIREMENTS.md): the assignment brief and the additional expectations.
- [Documentation map](docs/README.md): how the project is specified and where each kind of fact is written down.

## AI use

AI assistants helped plan, implement, review and test this project. Agent instructions are in [AGENTS.md](AGENTS.md).
