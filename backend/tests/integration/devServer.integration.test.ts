/* eslint-disable security/detect-non-literal-fs-filename -- rutas fijas del propio backend */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  localClient,
  localTableDefinitions,
} from '../../../infrastructure/scripts/local-tables.ts';
import { SYNTHETIC_ADMIN_SUB, assertLocalOnly, startDevServer } from '../../src/local/devServer.ts';
import { syntheticPdf } from '../../src/local/syntheticPdf.ts';

const stage = `dev${Date.now()}`;
let base: string;
let close: () => Promise<void>;
let dir: string;

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eira-dev-'));
  const started = await startDevServer({ port: 0, stage, dataDir: dir, minResponseMs: 0 });
  base = started.url;
  close = started.close;
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
  const raw = localClient();
  for (const { input } of localTableDefinitions(stage)) {
    await raw.send(new DeleteTableCommand({ TableName: input.TableName })).catch(() => undefined);
  }
});

describe('servidor local de demostración', () => {
  it('escucha solo en 127.0.0.1 y se niega a arrancar dentro de AWS', () => {
    expect(new URL(base).hostname).toBe('127.0.0.1');
    expect(() => assertLocalOnly({ AWS_LAMBDA_FUNCTION_NAME: 'eira-demo-x' })).toThrow();
    expect(() => assertLocalOnly({ AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs24.x' })).toThrow();
    expect(() => assertLocalOnly({})).not.toThrow();
  });

  it('paciente sintética: PIN de demo → sesión → resultado aprobado → PDF', async () => {
    const req = await call('POST', '/v1/access/request', {
      fullName: 'Ana Prueba Sintética',
      birthDate: '1985-03-14',
      folio: 'SINT-0001',
    });
    expect(req.status).toBe(202);
    const verify = await call('POST', '/v1/access/verify', {
      challengeId: req.body.challengeId,
      pin: req.body.demoPin,
    });
    const { token } = verify.body;
    const list = await call('GET', '/v1/results', undefined, token);
    expect(list.body.results).toHaveLength(1);
    const dl = await call(
      'POST',
      `/v1/results/${list.body.results[0].resultId}/download-url`,
      undefined,
      token,
    );
    const pdf = await fetch(dl.body.url);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).toString('latin1')).toContain('SIN VALOR CLINICO');
    expect((await call('GET', '/v1/results')).status).toBe(401);
    await call('POST', '/v1/access/logout', undefined, token);
    expect((await call('GET', '/v1/results', undefined, token)).status).toBe(401);
  });

  it('administración con identidad sintética: carga por URL firmada, revisión y aprobación', async () => {
    const patient = await call('GET', '/v1/admin/patients?folio=SINT-0003');
    const created = await call('POST', '/v1/admin/results', {
      patientId: patient.body.patientId,
      resultType: 'PAPANICOLAOU',
      sampleDate: '2026-11-10',
    });
    const id = created.body.resultId;
    const pdf = syntheticPdf(['SINT-0003']);
    const spec = {
      sha256: createHash('sha256').update(pdf).digest('base64'),
      sizeBytes: pdf.byteLength,
    };
    const up = await call('POST', `/v1/admin/results/${id}/upload-url`, {
      contentType: 'application/pdf',
      ...spec,
    });
    const put = (headers: Record<string, string>) =>
      fetch(up.body.url, { method: 'PUT', headers, body: pdf });
    const withoutCondition = Object.fromEntries(
      Object.entries(up.body.headers as Record<string, string>).filter(
        ([k]) => k !== 'if-none-match',
      ),
    );
    expect((await put(withoutCondition)).status).toBe(403);
    expect((await put(up.body.headers)).status).toBe(200);
    expect((await put(up.body.headers)).status).toBe(403);
    expect((await call('POST', `/v1/admin/results/${id}/submit`, spec)).body.status).toBe(
      'PENDING_REVIEW',
    );
    const review = await call('POST', `/v1/admin/results/${id}/review-url`);
    expect((await fetch(review.body.url)).status).toBe(200);
    const approved = await call('POST', `/v1/admin/results/${id}/review`, {
      decision: 'APPROVE',
      checks: { correspondence: true, integrity: true, legibility: true },
    });
    expect(approved.body.status).toBe('APPROVED');
    expect((await call('POST', `/v1/admin/results/${id}/review-url`)).status).toBe(409);
    const audit = await call(
      'GET',
      `/v1/admin/audit?${new URLSearchParams({ patientId: patient.body.patientId, from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })}`,
    );
    expect(
      audit.body.items.some((e: { actorId?: string }) => e.actorId === SYNTHETIC_ADMIN_SUB),
    ).toBe(true);
  });

  it('URL de documento alterada o ruta desconocida no dan acceso', async () => {
    expect((await fetch(`${base}/local-documents?key=x&exp=1&sig=y`)).status).toBe(403);
    expect((await call('GET', '/v1/nope')).status).toBe(404);
  });
});

describe('paquetes Lambda', () => {
  it('no contienen el servidor local ni la identidad administrativa sintética', async () => {
    const distDir = new URL('../../dist', import.meta.url).pathname;
    const files = (await readdir(distDir).catch(() => [])).filter((f) => f.endsWith('.mjs'));
    expect(files.length, 'ejecuta npm run build -w @eira/backend').toBeGreaterThan(0);
    for (const f of files) {
      const code = await readFile(join(distDir, f), 'utf8');
      expect(code, f).not.toContain(SYNTHETIC_ADMIN_SUB);
      expect(code, f).not.toContain('startDevServer');
      expect(code, f).not.toContain('LocalDocumentStorage');
    }
  });
});
