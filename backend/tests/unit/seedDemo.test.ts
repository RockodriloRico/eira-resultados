import { describe, expect, it } from 'vitest';
import { seedSyntheticViaApi } from '../../src/ops/seedDemo.ts';

const API = 'https://abc123.execute-api.us-east-1.amazonaws.com/demo';

function fakeApi(options: {
  submitStatus?: number;
  existing?: { sampleDate: string; status: string }[];
}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (init?.method === 'PUT') return new Response(null, { status: 200 });
    if (url.endsWith('/v1/admin/patients')) return json(201, {});
    if (url.includes('/v1/admin/patients?folio=')) return json(200, { patientId: 'pat_1' });
    if (url.endsWith('/v1/admin/results')) return json(201, { resultId: 'res_1' });
    if (url.endsWith('/results')) return json(200, { results: options.existing ?? [] });
    if (url.endsWith('/upload-url')) return json(200, { url: 'https://s3.example/x', headers: {} });
    if (url.endsWith('/submit')) return json(options.submitStatus ?? 200, {});
    return json(200, {});
  }) as typeof fetch;
}

describe('seedSyntheticViaApi', () => {
  it('falla si el envío a revisión no se completa', async () => {
    await expect(
      seedSyntheticViaApi({
        apiUrl: API,
        stage: 'demo',
        accessToken: 't',
        fetchFn: fakeApi({ submitStatus: 409 }),
      }),
    ).rejects.toThrow('Envío a revisión');
  });

  it('no da por sembrado un resultado que quedó a medias', async () => {
    await expect(
      seedSyntheticViaApi({
        apiUrl: API,
        stage: 'demo',
        accessToken: 't',
        fetchFn: fakeApi({ existing: [{ sampleDate: '2026-10-01', status: 'DRAFT' }] }),
      }),
    ).rejects.toThrow('quedó en DRAFT');
  });

  it('acepta que el personal haya decidido un resultado que el seed dejó en revisión', async () => {
    const existing = [
      { sampleDate: '2026-10-01', status: 'APPROVED' },
      { sampleDate: '2026-11-03', status: 'APPROVED' },
      { sampleDate: '2026-10-20', status: 'APPROVED' },
    ];
    await expect(
      seedSyntheticViaApi({
        apiUrl: API,
        stage: 'demo',
        accessToken: 't',
        fetchFn: fakeApi({ existing }),
      }),
    ).resolves.toBeDefined();
  });
});
