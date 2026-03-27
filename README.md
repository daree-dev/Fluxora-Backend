# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Today this repository exposes a minimal HTTP surface for stream CRUD and health checks. For Issue 54, the service now defines a concrete indexer-stall health classification plus an inline incident runbook so operators can reason about stale chain-derived state without relying on tribal knowledge.

## Decimal String Serialization Policy

All amounts crossing the chain/API boundary are serialized as **decimal strings** to prevent precision loss in JSON.

### Amount Fields

- `depositAmount` - Total deposit as decimal string (e.g., "1000000.0000000")
- `ratePerSecond` - Streaming rate as decimal string (e.g., "0.0000116")

### Validation Rules

- Amounts MUST be strings in decimal notation (e.g., "100", "-50", "0.0000001")
- Native JSON numbers are rejected to prevent floating-point precision issues
- Values exceeding safe integer ranges are rejected with `DECIMAL_OUT_OF_RANGE` error

### Error Codes

| Code                     | Description                               |
| ------------------------ | ----------------------------------------- |
| `DECIMAL_INVALID_TYPE`   | Amount was not a string                   |
| `DECIMAL_INVALID_FORMAT` | String did not match decimal pattern      |
| `DECIMAL_OUT_OF_RANGE`   | Value exceeds maximum supported precision |
| `DECIMAL_EMPTY_VALUE`    | Amount was empty or null                  |

### Trust Boundaries

| Actor                  | Capabilities                               |
| ---------------------- | ------------------------------------------ |
| Public Clients         | Read streams, submit valid decimal strings |
| Authenticated Partners | Create streams with validated amounts      |
| Administrators         | Full access, diagnostic logging            |
| Internal Workers       | Database operations, chain interactions    |

### Failure Modes

| Scenario                 | Behavior                          |
| ------------------------ | --------------------------------- |
| Invalid decimal type     | 400 with `DECIMAL_INVALID_TYPE`   |
| Malformed decimal string | 400 with `DECIMAL_INVALID_FORMAT` |
| Precision overflow       | 400 with `DECIMAL_OUT_OF_RANGE`   |
| Missing required field   | 400 with `VALIDATION_ERROR`       |
| Stream not found         | 404 with `NOT_FOUND`              |

### Operational Notes

#### Diagnostic Logging

Serialization events are logged with context for debugging:

```
Decimal validation failed {"field":"depositAmount","errorCode":"DECIMAL_INVALID_TYPE","requestId":"..."}
```

#### Health Observability

- `GET /health` - Returns service health status
- Request IDs enable correlation across logs
- Structured JSON logs for log aggregation systems

#### Verification Commands

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Build TypeScript
npm run build

# Start server
npm start
```

### Known Limitations

- In-memory stream storage (production requires database integration)
- No Stellar RPC integration (placeholder for chain interactions)
- Rate limiting not implemented (future enhancement)

## CORS Policy (Issue #26)

Service-level outcome for this scope:

- Production CORS behavior is explicit and predictable via a configured allowlist.
- Non-production environments remain permissive to keep local and staging workflows simple.

### Policy definition

- Environment variable: `CORS_ALLOWED_ORIGINS`
- Format: comma-separated origins, for example:
  - `CORS_ALLOWED_ORIGINS=https://app.fluxora.io,https://ops.fluxora.io`
- Production (`NODE_ENV=production`):
  - Cross-origin requests are only allowed for origins present in `CORS_ALLOWED_ORIGINS`.
  - Allowed preflight (`OPTIONS`) requests return `204` and include `Access-Control-Allow-*` headers.
  - Non-allowlisted preflight requests return `403` with `CORS_ORIGIN_DENIED`.
  - Requests from non-allowlisted origins do not receive `Access-Control-Allow-Origin`.
- Non-production (`development`, `test`, `staging`):
  - Incoming `Origin` is reflected to keep integration and QA flows frictionless.

### Trust boundaries for CORS

- Public internet clients:
  - May read public endpoints.
  - Browser access is limited by allowlist in production.
- Authenticated partners:
  - Must originate from registered partner domains in production.
  - Must still pass application-level auth once auth middleware is enabled.
- Administrators:
  - Maintain and rotate `CORS_ALLOWED_ORIGINS` per deployment.
  - Validate allowlist changes in staging before production rollout.
- Internal workers:
  - Not browser-originated and unaffected by CORS when calling internal services directly.

### Failure modes and expected behavior

- Invalid allowlist format (extra spaces, empty entries): empty entries are ignored; exact origin match is required.
- Allowlist missing in production: no cross-origin origin is allowed (safe default).
- Dependency outage (DB, Stellar RPC, worker): CORS policy is still evaluated first; health/error semantics remain unchanged.
- Partial data / duplicate delivery: outside CORS scope; existing endpoint behavior and error envelopes remain authoritative.

### Observability and incident diagnosis

- Health endpoint: `GET /health` confirms service liveness.
- Request correlation: `x-correlation-id` supports tracing denied preflight and API calls.
- Logs: request logger captures method/path/status to inspect spikes in `OPTIONS` or `403` responses.
- Operator runbook:
  - Confirm `NODE_ENV` and deployed `CORS_ALLOWED_ORIGINS`.
  - Reproduce with preflight:
    - `curl -i -X OPTIONS "$BASE_URL/api/streams" -H "Origin: https://candidate.example" -H "Access-Control-Request-Method: POST"`
  - If denied unexpectedly, compare exact origin (scheme + host + port) against allowlist.

### Verification evidence

- Automated regression tests in `tests/cors.test.ts` cover:
  - non-production permissive behavior
  - production allowlisted preflight success
  - production denied preflight behavior (`403` + `CORS_ORIGIN_DENIED`)
  - production safe default when allowlist is unset

### Intentional non-goals for this issue

- Dynamic allowlist management API.
- Wildcard or pattern-based origin matching.
- CORS-based authentication (CORS is not auth).

## What's in this repo

- Implemented today:
  - API info endpoint
  - health endpoint
  - in-memory stream CRUD placeholder
  - indexer freshness classification for `healthy`, `starting`, `stalled`, and `not_configured`
  - health-route reporting for indexer freshness
- Explicitly not implemented yet:
  - a real indexer worker
  - durable checkpoint persistence
  - database-backed chain state
  - automated restart orchestration
  - rate limiting or duplicate-delivery protection

If the health route reports `indexer.status = "stalled"`, treat that as an operational signal that chain-derived views would be stale if the real indexer were enabled in this service.

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

- `npm run dev` - run with tsx watch
- `npm run build` - compile to `dist/`
- `npm test` - run the HTTP error-handling tests
- `npm start` - run compiled `dist/index.js`
- `npm run docker:build` - build a production container image
- `npm run docker:run` - run the production container locally
- `npm run docker:smoke` - run a quick container health smoke check

## Production Docker Image (Issue #30)

### Service-level outcomes

- The backend can be packaged and started in a reproducible production image with a single command.
- The container runs as a non-root user and exposes only one HTTP port (`3000` by default).
- Operators get a built-in container health signal via Docker `HEALTHCHECK` against `GET /health`.
- Startup behavior is explicit: the process fails fast if the app cannot boot.

### Trust boundaries for containerized runtime

- Public internet clients: may call read/write API routes (`/`, `/health`, `/api/streams/**`) and receive normalized JSON responses.
- Authenticated partners: currently same HTTP capabilities as public clients (authentication is intentionally deferred and documented).
- Administrators/operators: may configure runtime through environment variables (`PORT`, `LOG_LEVEL`, `INDEXER_*`) and observe health/log output.
- Internal workers: represented by indexer health classification in `/health`; workers are not container-exposed endpoints.

### Failure modes and client-visible behavior

- Invalid input: returns `400` error envelopes from validation middleware.
- Dependency outage or stale worker checkpoint: `/health` reports `degraded` when indexer is `starting` or `stalled`.
- Partial data / missing stream: stream lookups return `404` (`NOT_FOUND`) when absent.
- Duplicate delivery/conflicting transitions: stream cancel path returns `409` (`CONFLICT`) for already-cancelled/completed streams.
- Process-level failure (boot error/panic): container exits non-zero so orchestrators can restart or alert.

### Operator observability and diagnostics

- Health endpoint: `GET /health` for liveness/degraded state, includes indexer freshness summary.
- Container health: Docker health status reflects HTTP health response.
- Logs: structured console logs include request metadata and request/correlation IDs for incident correlation.
- Triage flow:
  - Check `docker ps` health status.
  - Query `/health` and confirm `indexer.status`, `lagMs`, and `summary`.
  - Inspect container logs for request/error context.

### Verification evidence for this issue

Run the following commands:

```bash
npm run docker:build
npm run docker:smoke
```

Optional manual verification:

```bash
docker run --rm -p 3000:3000 fluxora-backend:local
curl -sS http://127.0.0.1:3000/health
```

### Non-goals and follow-up tracking

- This issue does not introduce authentication/authorization for containerized endpoints.
- This issue does not add database/Redis/Stellar readiness gating to container startup.
- This issue does not resolve all pre-existing TypeScript compilation debt across unrelated modules.
- Follow-up recommendation: add CI job that builds the image and runs `/health` smoke checks on every PR.

## API overview

| Method | Path               | Description                                                                      |
| ------ | ------------------ | -------------------------------------------------------------------------------- |
| GET    | `/`                | API info                                                                         |
| GET    | `/health`          | Health check                                                                     |
| GET    | `/api/streams`     | List streams                                                                     |
| GET    | `/api/streams/:id` | Get one stream                                                                   |
| POST   | `/api/streams`     | Create stream (body: sender, recipient, depositAmount, ratePerSecond, startTime) |

Contract guarantees for this area:

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

This is sufficient for local diagnosis now. If Redis, PostgreSQL, Horizon RPC, or workers are added later, their outage classifications should be folded into the same logging pattern.

### Verification evidence

Automated tests in `src/app.test.ts` cover:

- normalized `404` for unknown routes
- normalized `400` for invalid JSON
- normalized `413` for oversized payloads
- normalized `400` for route validation failures
- normalized `500` for unexpected exceptions

Build verification:

```bash
npm test
npm run build
```

### Non-goals and follow-up work

Intentionally deferred in this issue:

- rate limiting implementation
- duplicate-submission detection
- persistence-backed failure classification
- OpenAPI generation for error schemas

Recommended follow-up issues:

- add rate limiting that returns normalized `429` errors
- add idempotency / duplicate-submission protection
- publish OpenAPI schemas for the normalized error envelope
- extend dependency-outage classification once real database / indexing integrations land

## Project structure

```text
src/
  routes/     # health, streams
  index.ts    # Express app and server
k6/
  main.js     # k6 entrypoint — composes all scenarios
  config.js   # Thresholds, stage profiles, base URL
  helpers.js  # Shared metrics, check utilities, payload generators
  scenarios/
    health.js          # GET /health
    streams-list.js    # GET /api/streams
    streams-get.js     # GET /api/streams/:id (200 + 404 paths)
    streams-create.js  # POST /api/streams (valid + edge cases)
```

## Load testing (k6)

The `k6/` directory contains a [k6](https://k6.io/) load-testing harness for all critical endpoints.

### Prerequisites

Install k6 ([docs](https://grafana.com/docs/k6/latest/set-up/install-k6/)):

```bash
# macOS
brew install k6

# Windows (winget)
winget install k6 --source winget

# Windows (choco)
choco install k6

# Docker
docker pull grafana/k6
```

### Running

Start the API in one terminal:

```bash
npm run dev
```

Run a load test profile in another:

```bash
# Smoke (default — 5 VUs, 1 min, good for CI)
npm run k6:smoke

# Load (50 VUs, 5 min)
npm run k6:load

# Stress (ramp to 200 VUs)
npm run k6:stress

# Soak (30 VUs, 24 min — memory leak detection)
npm run k6:soak
```

Override the target URL for staging/production:

```bash
k6 run -e PROFILE=load -e K6_BASE_URL=https://staging.fluxora.io k6/main.js
```

### Profiles

| Profile | VUs   | Duration | Purpose                          |
|---------|-------|----------|----------------------------------|
| smoke   | 5     | 1 min    | CI gate / sanity check           |
| load    | 50    | 5 min    | Pre-release regression           |
| stress  | → 200 | 6 min    | Capacity ceiling / breaking point|
| soak    | 30    | 24 min   | Memory leaks / drift detection   |

### SLO thresholds

| Metric                 | Target         |
|------------------------|----------------|
| p(95) response time    | < 500 ms       |
| p(99) response time    | < 1 000 ms     |
| Error rate             | < 1 %          |
| Health p(99) latency   | < 200 ms       |

If any threshold is breached, k6 exits with a non-zero code — suitable for CI gates.

### Scenarios covered

- **health** — `GET /health` readiness probe; must never fail.
- **streams_list** — `GET /api/streams`; validates JSON array response.
- **streams_get** — `GET /api/streams/:id`; exercises both 200 (existing) and 404 (missing) paths.
- **streams_create** — `POST /api/streams`; valid payloads (201) and empty-body edge case.

### Trust boundaries modelled

| Boundary           | Endpoints                            | Notes |
|--------------------|--------------------------------------|-------|
| Public internet    | GET /health, GET /api/streams[/:id]  | Read-only, unauthenticated |
| Partner (future)   | POST /api/streams                    | Auth not yet enforced — tracked as follow-up |

### Failure modes tested

| Mode                    | Expected client behavior           | Covered by        |
|-------------------------|------------------------------------|--------------------|
| Missing stream ID       | 404 `{ error: "Stream not found" }`| streams-get        |
| Empty POST body         | Service defaults fields (201)      | streams-create     |
| Latency degradation     | Thresholds catch p95/p99 drift     | All scenarios      |

### Intentional non-goals (follow-up)

- **Auth header injection**: No JWT layer yet; will add when auth middleware lands.
- **Database failure injection**: In-memory store only; re-run after PostgreSQL migration.
- **Stellar RPC dependency simulation**: Requires contract integration work.
- **Rate-limiting verification**: Rate limiter not yet implemented.

### Observability / incident diagnosis

Operators can diagnose load-test runs via:

1. **k6 terminal summary** — real-time VU count, latency percentiles, error rate.
2. **k6 JSON output** — `k6 run --out json=results.json k6/main.js` for post-hoc analysis.
3. **Grafana Cloud k6** — `k6 cloud k6/main.js` streams results to a dashboard (requires account).

## Environment

Optional:

- `PORT` - server port, default `3000`

Likely future additions:

- `DATABASE_URL`
- `REDIS_URL`
- `HORIZON_URL`
- `JWT_SECRET`

## Related repos

- `fluxora-frontend` - dashboard and recipient UI
- `fluxora-contracts` - Soroban smart contracts
