import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Emit both human-readable HTML and machine-readable lcov for CI upload
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',       // entry-point bootstrap — not unit-testable
        'src/redis/client.ts', // thin ioredis wrapper — tested via integration
      ],
      // ── Coverage gate ────────────────────────────────────────────────────
      // CI will fail if any metric drops below 95 %.
      // Soroban/WASM contract interaction code lives in:
      //   src/services/streamEventService.ts  (event ingestion)
      //   src/db/repositories/streamRepository.ts (persistence)
      //   src/serialization/decimal.ts         (on-chain decimal handling)
      // These are included in the gate and must maintain ≥ 95 % coverage.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
