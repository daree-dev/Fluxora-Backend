export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  name: string;
  status: HealthStatus;
  latency?: number;
  error?: string;
  lastChecked: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  timestamp: string;
  uptime: number;
  /** Flat map: dependencyName → status string, e.g. { postgres: "healthy" } */
  dependencies: Record<string, string>;
}

export interface HealthChecker {
  name: string;
  check(): Promise<{ latency: number; error?: string }>;
}

export class HealthCheckManager {
  private checkers: Map<string, HealthChecker> = new Map();
  private lastResults: Map<string, DependencyHealth> = new Map();
  private readonly startTime = Date.now();

  registerChecker(checker: HealthChecker): void {
    this.checkers.set(checker.name, checker);
    this.lastResults.set(checker.name, {
      name: checker.name,
      status: 'healthy',
      lastChecked: new Date().toISOString(),
    });
  }

  async checkAll(version = '0.1.0'): Promise<HealthReport> {
    const results = await Promise.all(
      Array.from(this.checkers.values()).map((c) => this.checkOne(c)),
    );
    results.forEach((r) => this.lastResults.set(r.name, r));
    return this.buildReport(results, version);
  }

  private async checkOne(checker: HealthChecker): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      const result = await checker.check();
      return {
        name: checker.name,
        status: result.error ? 'unhealthy' : 'healthy',
        latency: Date.now() - start,
        error: result.error,
        lastChecked: new Date().toISOString(),
      };
    } catch (err) {
      return {
        name: checker.name,
        status: 'unhealthy',
        latency: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        lastChecked: new Date().toISOString(),
      };
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
