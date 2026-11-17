![bouncer-dashboard — illustrated bouncer filtering requests beside a monitoring dashboard](docs/images/bouncer-banner.jpeg)

# bouncer-dashboard

A per-user API rate limiter built as a NestJS interceptor, with a live React and TypeScript dashboard for administering it. Shared quota state lives in Redis so several API processes enforce one limit; changes reach the dashboard over WebSockets.

## How this repository is built

The project was developed in a private repository, specification first, with AI assistants. It is replayed here as a sequence of pull requests so that the order of work can be reviewed:

- Each pull request follows the [specification-first process](docs/README.md#specifications).
- The base requirements come first. Improvements are added on top of them afterwards.
- Commit dates are those of the replay, not of the original development.

The replay is in progress; the merged pull requests show how far it has come.

## Commands

Node.js 22.22.3 or later (the exact ranges are in `engines` in
`package.json`), and Docker for Redis.

```sh
npm ci
npm run build
npm run lint
npm test                            # needs nothing running
npm run check:contracts             # the fixture data against its own rules
npm run test:integration            # needs a Redis server of its own, below
npm run check:two-process           # after a build, on that same server; API ports 3203 and 3204
```

The integration suite and the two-process check empty database 1 of their
Redis, and the API's events travel over Redis Pub/Sub, which every database of
a server shares: a development API on the same server would exchange events
with them. Give them a server of their own, and run the checks one after
another, never at the same time:

```sh
docker run -d --rm --name bouncer-test-redis -p 127.0.0.1:6380:6379 redis:8-alpine
export TEST_REDIS_URL=redis://127.0.0.1:6380/1
npm run test:integration
npm run check:two-process
docker stop bouncer-test-redis
```

Without `TEST_REDIS_URL`, both use database 1 of the Compose Redis on :6379;
nothing else may use that server while they run.

To run the API and the dashboard on the host:

```sh
docker compose up -d redis          # Redis on 127.0.0.1:6379
cp .env.example .env                # demo values; each one is explained there
npm run dev                         # API on :3000, dashboard on http://localhost:5173
```

`npm run start:dev -w apps/api` starts the API alone. The dashboard also runs
without an API, on fixture data:

```sh
VITE_FIXTURES=1 npm run dev -w apps/web
```

## Documentation

- [Requirements](docs/REQUIREMENTS.md): the assignment brief and the additional expectations.
- [Documentation map](docs/README.md): how the project is specified and where each kind of fact is written down.

## AI use

AI assistants helped plan, implement, review and test this project. Agent instructions are in [AGENTS.md](AGENTS.md).
