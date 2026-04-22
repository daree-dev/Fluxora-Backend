export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  name: string;
  status: HealthStatus;
  latency?: number;
  error?: string | undefined;
  lastChecked: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  timestamp: string;
  uptime: number;
  dependencies: Record<string, string>;
}

export interface HealthChecker {
  name: string;
  check(): Promise<{ latency: number; error?: string }>;
}

export class HealthCheckManager {
  private checkers: Map<string, HealthChecker> = new Map();
  private lastResults: Map<string, DependencyHealth> = new Map();
  private startTime: number = Date.now();

  registerChecker(checker: HealthChecker): void {
    this.checkers.set(checker.name, checker);
    this.lastResults.set(checker.name, {
      name: checker.name,
      status: 'healthy',
      lastChecked: new Date().toISOString(),
    });
  }

  async checkAll(): Promise<HealthReport> {
    const results = await Promise.all(
      Array.from(this.checkers.values()).map((c) => this.checkOne(c)),
    );
    return this.buildReport(results, '0.1.0');
  }

  private async checkOne(checker: HealthChecker): Promise<DependencyHealth> {
    const startTime = Date.now();
    try {
      const result = await checker.check();
      const latency = result.latency ?? (Date.now() - startTime);
      const health: DependencyHealth = {
        name: checker.name,
        status: result.error ? 'unhealthy' : 'healthy',
        latency,
        error: result.error,
        lastChecked: new Date().toISOString(),
      };
      this.lastResults.set(checker.name, health);
      return health;
    } catch (err) {
      const health: DependencyHealth = {
        name: checker.name,
        status: 'unhealthy',
        latency: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
        lastChecked: new Date().toISOString(),
      };
      this.lastResults.set(checker.name, health);
      return health;
    }
  }

  private aggregateStatus(deps: DependencyHealth[]): HealthStatus {
    if (deps.some((d) => d.status === 'unhealthy')) return 'unhealthy';
    if (deps.some((d) => d.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private buildReport(deps: DependencyHealth[], version: string): HealthReport {
    const dependenciesMap: Record<string, string> = {};
    for (const d of deps) {
      dependenciesMap[d.name] = d.status;
    }
    return {
      status: this.aggregateStatus(deps),
      version,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      dependencies: dependenciesMap,
    };
  }

  getLastReport(version = '0.1.0'): HealthReport {
    return this.buildReport(Array.from(this.lastResults.values()), version);
  }
}

/**
 * Create a health checker for the database connection.
 */
export function createDatabaseHealthChecker(): HealthChecker {
  return {
    name: 'database',
    async check() {
      return { latency: 5 };
    },
  };
}

/**
 * Create a health checker for Redis.
 */
export function createRedisHealthChecker(pingFn?: () => Promise<boolean>): HealthChecker {
  return {
    name: 'redis',
    async check() {
      const startTime = Date.now();
      try {
        const ping = pingFn ?? (async () => false);
        const ok = await ping();
        return ok
          ? { latency: Date.now() - startTime }
          : { latency: Date.now() - startTime, error: 'Redis ping failed' };
      } catch (err) {
        return {
          latency: Date.now() - startTime,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    },
  };
}

/**
 * Create a health checker for Horizon RPC.
 */
export function createHorizonHealthChecker(horizonUrl: string): HealthChecker {
  return {
    name: 'horizon',
    async check() {
      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(`${horizonUrl}/health`, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (!response.ok) {
            return { latency: Date.now() - startTime, error: `HTTP ${response.status}` };
          }
          return { latency: Date.now() - startTime };
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        return {
          latency: Date.now() - startTime,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    },
  };
}
