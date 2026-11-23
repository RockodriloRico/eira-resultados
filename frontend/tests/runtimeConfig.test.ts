import { LOCAL_FRONTEND_CONFIG, buildFrontendConfig } from '@eira/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { loadRuntimeConfig, setRuntimeConfig } from '../src/config/runtime.ts';
import { mockFetch } from './fetchMock.ts';
import example from '../../infrastructure/env/stack-outputs.example.json';

const demo = buildFrontendConfig('demo', example.Outputs);
const at = (url: string) => new URL(url) as unknown as Location;

afterEach(() => vi.unstubAllGlobals());

describe('config.json en tiempo de ejecución', () => {
  it('acepta la configuración local en 127.0.0.1 y la pide sin caché ni cookies', async () => {
    const calls = mockFetch({ 'GET /config.json': () => ({ body: LOCAL_FRONTEND_CONFIG }) });
    await expect(loadRuntimeConfig(at('http://127.0.0.1:5173/'))).resolves.toEqual(
      LOCAL_FRONTEND_CONFIG,
    );
    expect(calls[0]?.init).toMatchObject({ cache: 'no-store', credentials: 'omit' });
  });

  it('rechaza la configuración local fuera de 127.0.0.1', async () => {
    mockFetch({ 'GET /config.json': () => ({ body: LOCAL_FRONTEND_CONFIG }) });
    await expect(loadRuntimeConfig(at('https://d111111abcdef8.cloudfront.net/'))).rejects.toThrow();
  });

  it('acepta la configuración desplegada solo en su propio origen', async () => {
    mockFetch({ 'GET /config.json': () => ({ body: demo }) });
    await expect(
      loadRuntimeConfig(at('https://d111111abcdef8.cloudfront.net/admin')),
    ).resolves.toEqual(demo);
    await expect(loadRuntimeConfig(at('https://d999999abcdef8.cloudfront.net/'))).rejects.toThrow(
      'otro origen',
    );
  });

  it('falla cerrada si config.json falta, es index.html o trae campos extra', async () => {
    mockFetch({ 'GET /config.json': () => ({ status: 404 }) });
    await expect(loadRuntimeConfig(at('http://127.0.0.1:5173/'))).rejects.toThrow();
    vi.stubGlobal('fetch', async () => new Response('<!doctype html><html></html>'));
    await expect(loadRuntimeConfig(at('http://127.0.0.1:5173/'))).rejects.toThrow();
    mockFetch({ 'GET /config.json': () => ({ body: { ...demo, secret: 'x' } }) });
    await expect(loadRuntimeConfig(at('https://d111111abcdef8.cloudfront.net/'))).rejects.toThrow();
  });

  it('el cliente de la API antepone apiBaseUrl', async () => {
    setRuntimeConfig(demo);
    const calls = mockFetch({
      'GET https://abcde12345.execute-api.us-east-1.amazonaws.com/demo/v1/results': () => ({
        body: { results: [] },
      }),
    });
    await expect(api('GET', '/v1/results', { token: 't' })).resolves.toEqual({ results: [] });
    expect(calls).toHaveLength(1);
  });
});
