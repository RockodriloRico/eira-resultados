import { describe, expect, it } from 'vitest';
import { buildFrontendConfig } from '@eira/shared';
import example from '../../../infrastructure/env/stack-outputs.example.json';
import { runSmoke } from '../../src/ops/smoke.ts';

const API = 'https://abcde12345.execute-api.us-east-1.amazonaws.com/demo';
const FRONT = 'https://d111111abcdef8.cloudfront.net';
const config = buildFrontendConfig('demo', example.Outputs);
const headers = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'content-security-policy': "default-src 'self'; script-src 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function fakeFetch(overrides: { headers?: Record<string, string>; demoPin?: boolean } = {}) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${FRONT}/`)
      return new Response('<html>', { headers: overrides.headers ?? headers });
    if (url.endsWith('/config.json'))
      return Response.json(config, { headers: { 'cache-control': 'no-store' } });
    if (url.endsWith('/v1/access/request')) {
      await new Promise((r) => setTimeout(r, 30));
      return Response.json(
        { challengeId: 'chl_x', ...(overrides.demoPin === false ? {} : { demoPin: '123456' }) },
        { status: 202 },
      );
    }
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  }) as typeof fetch;
}

describe('smoke tests posteriores al despliegue', () => {
  it('un despliegue demo correcto pasa todas las comprobaciones', async () => {
    const checks = await runSmoke({
      apiUrl: API,
      frontendUrl: FRONT,
      stage: 'demo',
      floorMs: 20,
      fetchFn: fakeFetch(),
    });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks).toHaveLength(6);
  });

  it('detecta encabezados de seguridad ausentes, demoPin fuera de demo y config de otro entorno', async () => {
    const checks = await runSmoke({
      apiUrl: API,
      frontendUrl: FRONT,
      stage: 'prod',
      floorMs: 20,
      fetchFn: fakeFetch({ headers: { 'x-content-type-options': 'nosniff' } }),
    });
    const failed = checks.filter((c) => !c.ok).map((c) => c.detail);
    expect(failed).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HSTS'),
        expect.stringContaining('stage demo'),
        expect.stringContaining('demoPin'),
      ]),
    );
  });

  it('falla si la respuesta llega antes del piso', async () => {
    const checks = await runSmoke({
      apiUrl: API,
      stage: 'demo',
      floorMs: 1000,
      fetchFn: fakeFetch(),
    });
    expect(checks.find((c) => c.name.startsWith('access/request'))!.ok).toBe(false);
  });
});
