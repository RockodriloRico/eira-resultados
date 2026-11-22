import { vi } from 'vitest';

type Handler = (init: RequestInit | undefined) => { status?: number; body?: unknown };

/** fetch simulado por "MÉTODO ruta" (la ruta sin query string). */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: { key: string; init: RequestInit | undefined; url: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    calls.push({ key, init, url });
    const handler = routes[key];
    const out = handler ? handler(init) : { status: 404, body: { message: 'No encontrado' } };
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
      status: out.status ?? 200,
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
