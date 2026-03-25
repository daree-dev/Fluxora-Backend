# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Provides REST endpoints for streams, health checks, and (later) Horizon sync and analytics.

## What's in this repo

- **API Gateway** — REST API for stream CRUD and health
- **Streams API** — List, get, and create stream records (in-memory placeholder; will be replaced by PostgreSQL + Horizon listener)
- Ready to extend with JWT, RBAC, rate limiting, and streaming engine

## Tech stack

- Node.js 18+
- TypeScript
- Express

## Local setup

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install and run

```bash
npm install
npm run dev
```

API runs at [http://localhost:3000](http://localhost:3000).

### Scripts

- `npm run dev` — Run with tsx watch (no build)
- `npm run build` — Compile to `dist/`
- `npm start` — Run compiled `dist/index.js`

## API overview

| Method | Path              | Description        |
|--------|-------------------|--------------------|
| GET    | `/`               | API info           |
| GET    | `/health`         | Health check       |
| GET    | `/api/streams`   | List streams       |
| GET    | `/api/streams/:id` | Get one stream   |
| POST   | `/api/streams`   | Create stream (body: sender, recipient, depositAmount, ratePerSecond, startTime) |
| POST   | `/api/streams/lookup` | Bulk fetch streams by IDs (body: ids: string[]) |

All responses are JSON. Stream data is in-memory until you add PostgreSQL.

## Operational Guidelines

### Trust Boundaries
- **Public API**: The `/api/streams/lookup` endpoint is accessible to any client with stream IDs. Currently, no authentication is enforced.
- **Failures**: Invalid JSON or missing `ids` array returns `400 Bad Request`. Non-existent IDs are silently omitted from the response to prevent information leakage and ensure robustness for partial matches.

### Health and Observability
- **Success Metrics**: Monitor `200 OK` responses for the lookup endpoint.
- **Error Monitoring**: Track `400` errors for client integration issues.
- **Diagnostics**: If streams are not found, verify the stream creation logs or ensure the in-memory state hasn't been reset by a restart.

## Project structure
...

```
src/
  routes/     # health, streams
  index.ts    # Express app and server
```

## Environment

Optional:

- `PORT` — Server port (default: 3000)

Later you can add `DATABASE_URL`, `REDIS_URL`, `HORIZON_URL`, `JWT_SECRET`, etc.

## Related repos

- **fluxora-frontend** — Dashboard and recipient UI
- **fluxora-contracts** — Soroban smart contracts

Each is a separate Git repository.
