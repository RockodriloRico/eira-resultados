import { frontendConfigSchema } from '@eira/shared';

/**
 * Smoke tests posteriores al despliegue (ADR-0014). Solo HTTP público, sin credenciales de AWS y
 * con identidades inexistentes: no crean sesiones, no envían SMS y no leen datos de pacientes.
 */
export type SmokeCheck = { name: string; ok: boolean; detail: string };

export type SmokeOptions = {
  apiUrl: string;
  frontendUrl?: string;
  stage: 'local' | 'dev' | 'demo' | 'prod';
  floorMs?: number;
  fetchFn?: typeof fetch;
};

const NONEXISTENT = {
  fullName: 'Persona Inexistente Smoke',
  birthDate: '1970-01-01',
  folio: 'SINT-SMOKE-0000',
};
const FAKE_RESULT = 'res_AAAAAAAAAAAAAAAAAAAAAA';

export async function runSmoke(options: SmokeOptions): Promise<SmokeCheck[]> {
  const doFetch = options.fetchFn ?? fetch;
  const checks: SmokeCheck[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const expect = (cond: boolean, message: string) => {
    if (!cond) throw new Error(message);
  };

  if (options.frontendUrl) {
    const base = options.frontendUrl.replace(/\/$/, '');
    await check('frontend: HTTPS y encabezados de seguridad', async () => {
      expect(base.startsWith('https://'), 'el frontend no usa HTTPS');
      const res = await doFetch(`${base}/`);
      expect(res.status === 200, `GET / respondió ${res.status}`);
      const h = (k: string) => res.headers.get(k) ?? '';
      expect(h('strict-transport-security').includes('max-age='), 'falta HSTS');
      expect(h('content-security-policy').includes("default-src 'self'"), 'falta CSP');
      expect(h('x-content-type-options') === 'nosniff', 'falta nosniff');
      expect(h('x-frame-options') === 'DENY', 'falta X-Frame-Options DENY');
      return 'HSTS, CSP, nosniff y DENY presentes';
    });
    await check('frontend: config.json válido, sin caché y del mismo entorno', async () => {
      const res = await doFetch(`${base}/config.json`);
      expect(res.status === 200, `config.json respondió ${res.status}`);
      expect((res.headers.get('cache-control') ?? '').includes('no-store'), 'config.json en caché');
      const config = frontendConfigSchema.parse(await res.json());
      expect(config.stage === options.stage, `stage ${config.stage} ≠ ${options.stage}`);
      expect(
        config.apiBaseUrl.replace(/\/$/, '') === options.apiUrl.replace(/\/$/, ''),
        'apiBaseUrl no coincide con la API probada',
      );
      return `stage ${config.stage}`;
    });
  }

  const api = options.apiUrl.replace(/\/$/, '');
  const floor = options.floorMs ?? 1000;
  await check('access/request: 202 genérico y piso anti-enumeración', async () => {
    const started = performance.now();
    const res = await doFetch(`${api}/v1/access/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(NONEXISTENT),
    });
    const ms = Math.round(performance.now() - started);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status === 202, `respondió ${res.status}`);
    expect(typeof body.challengeId === 'string', 'sin challengeId');
    expect(ms >= floor, `respondió en ${ms} ms (< ${floor})`);
    const exposesPin = 'demoPin' in body;
    expect(
      exposesPin === (options.stage === 'demo' || options.stage === 'local'),
      'demoPin fuera de demo',
    );
    return `${ms} ms`;
  });
  await check('results: sin sesión no hay acceso', async () => {
    const res = await doFetch(`${api}/v1/results`);
    expect([401, 403].includes(res.status), `respondió ${res.status}`);
    return String(res.status);
  });
  await check('results: token inventado rechazado', async () => {
    const res = await doFetch(`${api}/v1/results/${FAKE_RESULT}/download-url`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    });
    expect([401, 403].includes(res.status), `respondió ${res.status}`);
    return String(res.status);
  });
  if (options.stage !== 'local') {
    await check('admin: sin token de Cognito no hay acceso', async () => {
      const res = await doFetch(`${api}/v1/admin/patients?folio=SINT-0001`);
      expect([401, 403].includes(res.status), `respondió ${res.status}`);
      return String(res.status);
    });
  }
  return checks;
}
