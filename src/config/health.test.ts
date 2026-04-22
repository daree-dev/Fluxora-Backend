import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  HealthCheckManager,
  HealthChecker,
  createDatabaseHealthChecker,
  createRedisHealthChecker,
  createHorizonHealthChecker,
} from './health.js';

function makeChecker(name: string, mode: 'ok' | 'fail' | 'throw' = 'ok'): HealthChecker {
  return {
    name,
    async check() {
      if (mode === 'fail') return { latency: 10, error: 'simulated failure' };
      if (mode === 'throw') throw new Error('simulated throw');
      return { latency: 5 };
    },
  };
}

describe('HealthCheckManager', () => {
  let manager: HealthCheckManager;

  beforeEach(() => {
    manager = new HealthCheckManager();
  });

  it('registers a checker and reflects it in getLastReport', () => {
    manager.registerChecker(makeChecker('db'));
    const report = manager.getLastReport();
    expect(report.dependencies['db']).toBe('healthy');
  });

  it('checkAll returns healthy when all checkers pass', async () => {
    manager.registerChecker(makeChecker('a'));
    manager.registerChecker(makeChecker('b'));
    const report = await manager.checkAll();
    expect(report.status).toBe('healthy');
    expect(report.dependencies['a']).toBe('healthy');
    expect(report.dependencies['b']).toBe('healthy');
  });

  it('checkAll returns unhealthy when a checker returns an error', async () => {
    manager.registerChecker(makeChecker('a'));
    manager.registerChecker(makeChecker('b', 'fail'));
    const report = await manager.checkAll();
    expect(report.status).toBe('unhealthy');
    expect(report.dependencies['b']).toBe('unhealthy');
  });

  it('checkAll returns unhealthy when a checker throws', async () => {
    manager.registerChecker(makeChecker('throwing', 'throw'));
    const report = await manager.checkAll();
    expect(report.status).toBe('unhealthy');
  });

  it('checkAll returns healthy with no checkers', async () => {
    const report = await manager.checkAll();
    expect(report.status).toBe('healthy');
    expect(Object.keys(report.dependencies)).toHaveLength(0);
  });

  it('includes uptime as a non-negative number', async () => {
    manager.registerChecker(makeChecker('x'));
    const report = await manager.checkAll();
    expect(report.uptime).toBeGreaterThanOrEqual(0);
  });

  it('includes timestamp and version in report', async () => {
    manager.registerChecker(makeChecker('x'));
    const report = await manager.checkAll();
    expect(new Date(report.timestamp).getTime()).toBeGreaterThan(0);
    expect(report.version).toBe('0.1.0');
  });

  it('getLastReport reflects results after checkAll', async () => {
    manager.registerChecker(makeChecker('x', 'fail'));
    await manager.checkAll();
    expect(manager.getLastReport().dependencies['x']).toBe('unhealthy');
  });

  it('returns degraded when a dependency is in degraded state', () => {
    manager.registerChecker(makeChecker('dep'));
    (manager as unknown as { lastResults: Map<string, { name: string; status: string; lastChecked: string }> })
      .lastResults.set('dep', { name: 'dep', status: 'degraded', lastChecked: new Date().toISOString() });
    expect(manager.getLastReport().status).toBe('degraded');
  });

  describe('built-in checkers', () => {
    it('createDatabaseHealthChecker returns a checker named "database"', async () => {
      const checker = createDatabaseHealthChecker();
      expect(checker.name).toBe('database');
      const result = await checker.check();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('createRedisHealthChecker returns healthy when ping returns true', async () => {
      const checker = createRedisHealthChecker(async () => true);
      const result = await checker.check();
      expect(result.error).toBeUndefined();
    });

    it('createRedisHealthChecker returns error when ping returns false', async () => {
      const checker = createRedisHealthChecker(async () => false);
      const result = await checker.check();
      expect(result.error).toBe('Redis ping failed');
    });

    it('createRedisHealthChecker handles ping throwing', async () => {
      const checker = createRedisHealthChecker(async () => { throw new Error('conn refused'); });
      const result = await checker.check();
      expect(result.error).toBe('conn refused');
    });

    it('createHorizonHealthChecker returns a checker named "horizon"', () => {
      const checker = createHorizonHealthChecker('https://horizon.stellar.org');
      expect(checker.name).toBe('horizon');
    });

    it('createHorizonHealthChecker handles unreachable host', async () => {
      const checker = createHorizonHealthChecker('http://127.0.0.1:1');
      const result = await checker.check();
      expect(result.error).toBeDefined();
    });
  });
});
