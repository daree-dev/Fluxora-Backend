/**
 * Rate limiter middleware tests.
 *
 * Uses InMemoryCacheClient so no Redis instance is required.
 */

import express, { Application } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { InMemoryCacheClient, setCacheClient, resetCacheClient } from '../src/cache/redis.js';

function buildApp(max: number, windowSeconds = 60): Application {
  const app = express();
  app.use(createRateLimiter({ max, windowSeconds, keyPrefix: 'test-rl' }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('createRateLimiter', () => {
  let cache: InMemoryCacheClient;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
    setCacheClient(cache);
  });

  afterEach(async () => {
    resetCacheClient();
    await cache.quit();
  });

  it('allows requests under the limit', async () => {
    const app = buildApp(5);
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
  });

  it('sets X-RateLimit-* headers on allowed requests', async () => {
    const app = buildApp(10);
    const res = await request(app).get('/ping');
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns 429 when limit is exceeded', async () => {
    const app = buildApp(2);
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
    const res = await request(app).get('/ping').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.body.error.status).toBe(429);
  });

  it('includes Retry-After header on 429', async () => {
    const app = buildApp(1, 30);
    await request(app).get('/ping');
    const res = await request(app).get('/ping').expect(429);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('X-RateLimit-Remaining is 0 on 429', async () => {
    const app = buildApp(1);
    await request(app).get('/ping');
    const res = await request(app).get('/ping').expect(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('fails open when cache is unavailable', async () => {
    resetCacheClient(); // NullCacheClient — always returns null
    const app = buildApp(1);
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
  });

  it('respects X-Forwarded-For for IP extraction', async () => {
    const app = buildApp(1);
    await request(app).get('/ping').set('X-Forwarded-For', '1.2.3.4').expect(200);
    await request(app).get('/ping').set('X-Forwarded-For', '1.2.3.4').expect(429);
    await request(app).get('/ping').set('X-Forwarded-For', '5.6.7.8').expect(200);
  });
});
