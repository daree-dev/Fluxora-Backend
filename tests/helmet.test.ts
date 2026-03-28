import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

describe('helmet security headers', () => {
  it('sets Content-Security-Policy header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('sets X-Content-Type-Options to nosniff', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options to SAMEORIGIN', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('removes X-Powered-By header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets Strict-Transport-Security header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('sets X-DNS-Prefetch-Control header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('sets X-Download-Options header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-download-options']).toBe('noopen');
  });

  it('sets X-Permitted-Cross-Domain-Policies header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-permitted-cross-domain-policies']).toBe('none');
  });

  it('sets Referrer-Policy header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('applies headers to all routes', async () => {
    const routes = ['/health', '/api/streams', '/'];
    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });
});
