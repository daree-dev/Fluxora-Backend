# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. This repository currently exposes a minimal HTTP surface for stream CRUD and health checks. For Issue 5, the service now defines one normalized API error envelope so clients, operators, and auditors see predictable failure semantics instead of route-specific JSON shapes.

## Current status

- Implemented today:
  - API info endpoint
  - health endpoint
  - in-memory stream CRUD placeholder
  - global API error handler with a normalized JSON envelope
  - request id propagation via `x-request-id`
- Explicitly not implemented yet:
  - database-backed persistence
  - indexing workers / chain-derived state
  - rate limiting middleware
  - duplicate-submission protection
  - OpenAPI generation

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

## API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info |
| GET | `/health` | Health check |
| GET | `/api/streams` | List streams |
| GET | `/api/streams/:id` | Get one stream |
| POST | `/api/streams` | Create stream with `sender`, `recipient`, `depositAmount`, `ratePerSecond`, `startTime` |

All responses are JSON. Stream data is in-memory until a durable store is added.

## Normalized API error JSON

### Service-level outcome

Every handled API failure should return the same envelope shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "`recipient` is required",
    "status": 400,
    "requestId": "6e8f9ad8-1d9a-4ca8-9ec9-62b6ef1d56e4",
    "details": {
      "field": "recipient"
    }
  }
}
```

Contract guarantees for this area:

- every normalized error includes `code`, `message`, `status`, and `requestId`
- route validation, invalid JSON, payload-size failures, not-found cases, and unhandled exceptions all use the same top-level error envelope
- 5xx responses never leak raw stack traces to clients
- the response header `x-request-id` matches the `requestId` inside the JSON body

### Error codes currently used

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `validation_error` | `400` | Route-level input validation failed |
| `invalid_json` | `400` | Request body could not be parsed as JSON |
| `payload_too_large` | `413` | Request body exceeded the `256 KiB` JSON limit |
| `not_found` | `404` | No route matched the request |
| `stream_not_found` | `404` | The requested stream id does not exist |
| `internal_error` | `500` | Unexpected server failure |

### Trust boundaries

| Actor | Trusted for | Not trusted for |
|-------|-------------|-----------------|
| Public internet clients | Sending syntactically valid requests | Choosing their own success semantics, bypassing validation, or forcing stack traces into responses |
| Authenticated partners | Same normalized failure contract as public clients once auth exists | Receiving privileged diagnostics or internal dependency details in error bodies |
| Administrators / operators | Correlating `requestId` values with logs and incidents | Relying on client-visible payloads alone for root-cause analysis |
| Internal workers / future indexers | Raising typed application errors that can be normalized | Skipping the shared error contract when surfacing failures through HTTP |

### Failure modes and expected client-visible behavior

| Scenario | Expected client-visible behavior |
|----------|---------------------------------|
| Invalid JSON body | `400` with `invalid_json` |
| Missing or malformed route fields | `400` with `validation_error` and a `details.field` hint where applicable |
| Unknown route | `404` with `not_found` |
| Known stream id missing | `404` with `stream_not_found` |
| Oversized JSON body | `413` with `payload_too_large` |
| Unhandled exception | `500` with `internal_error` and no internal stack trace |
| Excessive request rates | Deferred: no rate limiter exists yet; once added, it must use the same envelope with `429` |
| Duplicate submissions | Deferred: no idempotency or dedupe store exists yet; current stream creation accepts duplicates |
| Dependency outage / partial data | Deferred in this repo version; once external dependencies exist, their failures must also normalize into the same envelope |

### Abuse and reliability notes

- Oversized payloads are bounded at the JSON parser with a `256 KiB` limit.
- Excessive request rates are not yet actively throttled. This is documented as deferred rather than implied.
- Duplicate submissions are not currently rejected. That behavior is also documented as deferred.
- The global handler ensures that even when behavior is deferred, the failure contract for implemented paths remains predictable.

### Operator observability and incident diagnosis

Operators should be able to answer the following without tribal knowledge:

- which request id corresponded to the failing client report
- whether the failure was validation, parsing, routing, payload-size, or unexpected internal failure
- whether the client saw a 4xx or a 5xx outcome
- which route and method produced the failure

Current operator signals:

- `x-request-id` is generated or forwarded on every request
- the global error handler logs:
  - request id
  - HTTP status
  - normalized error code
  - HTTP method
  - request path
  - internal error message
  - structured details when present

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
  app.ts         # Express app factory and middleware wiring
  errors.ts      # global error model and error middleware
  routes/        # health and streams routes
  index.ts       # server bootstrap
```

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
