# Test Coverage — Contract Tests

## Overview

All backend code that models or interacts with the Soroban payment-stream contract must maintain
**≥ 95 % coverage** across lines, functions, branches, and statements.  This gate is enforced
automatically in CI and will block merges if the threshold is breached.

---

## What counts as "contract tests"

This is a backend API project — the Soroban contracts live in a separate repository
(`fluxora-contracts`).  "Contract tests" here means the backend code that directly represents
on-chain state or communicates with the Soroban RPC:

| File | Role |
|------|------|
| `src/services/streamEventService.ts` | Ingests Soroban RPC events and writes stream records |
| `src/db/repositories/streamRepository.ts` | Persists and queries on-chain stream state |
| `src/serialization/decimal.ts` | Validates and formats on-chain decimal strings |
| `src/routes/streams.ts` | HTTP surface of the contract API (CRUD + status transitions) |
| `src/indexer/service.ts` | Polls Soroban RPC for new ledger events |
| `src/lib/stellar-rpc.ts` | Thin wrapper around the Stellar Soroban RPC client |

All of the above are included in the global coverage gate — there is no separate "contract-only"
run.  The full test suite must stay above 95 % for every metric.

---

## Running coverage locally

### Prerequisites

```bash
# @vitest/coverage-v8 must be installed (it is in devDependencies)
pnpm install
```

### One-shot coverage report

```bash
pnpm run test:coverage
```

Vitest will:
1. Run the full test suite under Node's built-in v8 coverage instrumentation.
2. Print a summary table to stdout.
3. Write detailed reports to `./coverage/`:
   - `coverage/index.html` — interactive HTML report (open in a browser)
   - `coverage/lcov.info` — machine-readable LCOV (used by CI upload and editor plugins)

If any metric is below 95 % the process exits with a non-zero code, matching CI behaviour.

### Open the HTML report

```bash
# macOS
open coverage/index.html

# Linux
xdg-open coverage/index.html

# Windows
start coverage/index.html
```

### Watch mode (development)

Coverage is not collected in watch mode by default (it slows the feedback loop).  Run a
one-shot report whenever you want to check your numbers:

```bash
# Fast watch loop — no coverage
pnpm run test:watch

# Check coverage on demand
pnpm run test:coverage
```

---

## Soroban / WASM caveats

### 1. No WASM execution in unit tests

The backend never executes Soroban WASM directly.  It communicates with an already-deployed
contract via the **Stellar Soroban RPC** (`src/lib/stellar-rpc.ts`).  All unit and integration
tests mock the RPC layer, so there is no need to compile or load WASM in the test environment.

### 2. Soroban RPC is mocked

`src/services/streamEventService.ts` and `src/indexer/service.ts` call the Soroban RPC to fetch
ledger events.  In tests these calls are replaced with in-memory stubs:

```typescript
// Example pattern used in tests/stellar-rpc.test.ts
vi.mock('../src/lib/stellar-rpc.js', () => ({
  fetchEvents: vi.fn().mockResolvedValue([]),
}));
```

This means coverage numbers reflect the application logic, not the RPC transport.

### 3. Decimal-string invariant

On-chain amounts cross the API boundary as **decimal strings** (e.g. `"1000000.0000000"`).
JSON floating-point numbers are rejected with `400 VALIDATION_ERROR`.  The serialization module
(`src/serialization/decimal.ts`) and its tests (`tests/decimal.test.ts`) are the primary
coverage target for this invariant.

### 4. Contract ID and transaction hash fields

`contract_id` and `transaction_hash` are stored as plain `TEXT` in PostgreSQL.  No Stellar SDK
validation is applied at the HTTP layer — that is intentional to keep the API forward-compatible
with future contract upgrades.  Tests cover the storage and retrieval paths but not Stellar
address checksum validation.

### 5. Running against a real Soroban testnet

The test suite is fully offline by default.  To run against a live Soroban testnet:

```bash
# Copy and fill in real credentials
cp .env.example .env

# Edit .env:
#   HORIZON_URL=https://horizon-testnet.stellar.org
#   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
#   DATABASE_URL=postgresql://...
#   REDIS_URL=redis://...

# Run the server (not the test suite — integration against live RPC is manual)
pnpm run dev
```

Live-network integration tests are out of scope for the automated coverage gate.

---

## CI behaviour

The coverage gate runs as a separate `coverage` job in `.github/workflows/ci.yml`, gated on the
`build` job succeeding first.

```
push / PR
    │
    ▼
┌─────────┐     ┌──────────────────────────────┐
│  build  │────►│  coverage (≥95% gate)        │
│ (18+20) │     │  Node 20 only — fast         │
└─────────┘     │  uploads coverage/ artifact  │
                └──────────────────────────────┘
```

- The `build` job runs on both Node 18 and 20 (matrix) to catch compatibility issues.
- The `coverage` job runs on Node 20 only to avoid doubling CI time.
- The coverage artifact (`coverage/`) is retained for 14 days and downloadable from the
  GitHub Actions run summary.
- If you have a Codecov account, set the `CODECOV_TOKEN` repository secret and the lcov report
  will be uploaded automatically.

### What causes the gate to fail

| Scenario | Result |
|----------|--------|
| Any metric (lines/functions/branches/statements) < 95 % | ❌ CI fails |
| A test file throws an uncaught error | ❌ CI fails |
| New source file added with no tests | ❌ CI fails (lines drop) |
| Excluded file (`src/index.ts`, `src/redis/client.ts`) | ✅ Not counted |

### Fixing a failing gate

1. Run `pnpm run test:coverage` locally to see which files are under-covered.
2. Open `coverage/index.html` to drill into uncovered lines (shown in red).
3. Add tests for the uncovered paths.
4. Re-run until all metrics are ≥ 95 %.

If a file genuinely cannot be unit-tested (e.g. a thin infrastructure wrapper), add it to the
`exclude` array in `vitest.config.ts` with a comment explaining why.

---

## Threshold configuration

Thresholds are defined in `vitest.config.ts`:

```typescript
thresholds: {
  lines:      95,
  functions:  95,
  branches:   95,
  statements: 95,
},
```

To raise or lower the threshold, edit that file and open a PR.  Any change to the threshold
requires a reviewer sign-off to prevent accidental regressions.
