import { describe, it, expect, beforeEach } from '@jest/globals';
import { HealthCheckManager } from './health';
import type { HealthChecker } from './health';

describe('HealthCheckManager', () => {
  let manager: HealthCheckManager;

  beforeEach(() => {
    manager = new HealthCheckManager();
  });

  const makeChecker = (name: string, error?: string): HealthChecker => ({
    name,
    async check() { return { latency: 5, ...(error ? { error } : {}) }; },
  });

  const throwingChecker = (name: string, value: unknown = new Error('Unexpected error')): HealthChecker => ({
    name,
    async check() { throw value; },
  });

  describe('registerChecker', () => {
    it('registers a checker and appears in getLastReport', () => {
      manager.registerChecker(makeChecker('test'));
      expect(manager.getLastReport().dependencies).toHaveProperty('test');
    });

    it('registers multiple checkers', () => {
      manager.registerChecker(makeChecker('a'));
      manager.registerChecker(makeChecker('b'));
      expect(Object.keys(manager.getLastReport().dependencies)).toHaveLength(2);
    });
  });

  describe('checkAll', () => {
    it('returns healthy when all checkers pass', async () => {
      manager.registerChecker(makeChecker('postgres'));
      manager.registerChecker(makeChecker('stellar_rpc'));
      const report = await manager.checkAll();
      expect(report.status).toBe('healthy');
      expect(report.dependencies).toEqual({ postgres: 'healthy', stellar_rpc: 'healthy' });
    });

    it('returns unhealthy when a checker returns an error', async () => {
      manager.registerChecker(makeChecker('postgres', 'Connection refused'));
      const report = await manager.checkAll();
      expect(report.status).toBe('unhealthy');
      expect(report.dependencies.postgres).toBe('unhealthy');
    });

    it('returns unhealthy when a checker throws an Error', async () => {
      manager.registerChecker(throwingChecker('postgres'));
      const report = await manager.checkAll();
      expect(report.status).toBe('unhealthy');
      expect(report.dependencies.postgres).toBe('unhealthy');
    });

    it('returns unhealthy when a checker throws a non-Error value', async () => {
      manager.registerChecker(throwingChecker('postgres', 'raw string'));
      const report = await manager.checkAll();
      expect(report.dependencies.postgres).toBe('unhealthy');
    });

    it('aggregates: unhealthy wins over healthy', async () => {
      manager.registerChecker(makeChecker('a'));
      manager.registerChecker(makeChecker('b', 'fail'));
      expect((await manager.checkAll()).status).toBe('unhealthy');
    });

    it('includes uptime as a non-negative number', async () => {
      manager.registerChecker(makeChecker('x'));
      expect((await manager.checkAll()).uptime).toBeGreaterThanOrEqual(0);
    });

    it('includes a valid ISO timestamp', async () => {
      manager.registerChecker(makeChecker('x'));
      expect(new Date((await manager.checkAll()).timestamp).getTime()).toBeGreaterThan(0);
    });

    it('includes version', async () => {
      manager.registerChecker(makeChecker('x'));
      expect((await manager.checkAll('1.2.3')).version).toBe('1.2.3');
    });
  });

  describe('getLastReport', () => {
    it('returns initial healthy status before first checkAll', () => {
      manager.registerChecker(makeChecker('x'));
      const report = manager.getLastReport();
      expect(report.status).toBe('healthy');
      expect(report.dependencies.x).toBe('healthy');
    });

    it('reflects results after checkAll', async () => {
      manager.registerChecker(makeChecker('x', 'fail'));
      await manager.checkAll();
      expect(manager.getLastReport().dependencies.x).toBe('unhealthy');
    });

    it('returns degraded when a dependency is in degraded state', () => {
      manager.registerChecker(makeChecker('dep'));
      // Directly set degraded state to exercise the aggregation branch
      (manager as unknown as { lastResults: Map<string, { name: string; status: string; lastChecked: string }> })
        .lastResults.set('dep', { name: 'dep', status: 'degraded', lastChecked: new Date().toISOString() });
      expect(manager.getLastReport().status).toBe('degraded');
    });
  });
});
