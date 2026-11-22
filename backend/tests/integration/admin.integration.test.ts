import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SECURITY_POLICY } from '@eira/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/app/container.ts';
import {
  adminAuditRoute,
  adminPatientsRoute,
  adminResultsRoute,
  adminReviewUrlRoute,
} from '../../src/http/adminRoutes.ts';
import { httpHandler } from '../../src/http/handler.ts';
import { syntheticPdf } from '../../src/local/syntheticPdf.ts';
import { MockSmsProvider } from '../../src/sms/SmsProvider.ts';
import { LocalDocumentStorage, sha256Base64 } from '../../src/storage/DocumentStorage.ts';
import { createTestEnv, type TestEnv } from './localEnv.ts';

let env: TestEnv;
let app: Container;
let storage: LocalDocumentStorage;
let dir: string;
let nowMs = Date.now();
const clock = () => new Date(nowMs);
const admin = { adminId: 'adm-sint-1', requestId: 'req' };

const call = (
  route: ReturnType<typeof adminPatientsRoute>,
  method: string,
  resource: string,
  opts: {
    body?: unknown;
    path?: Record<string, string>;
    query?: Record<string, string>;
    sub?: string | null;
  } = {},
) =>
  httpHandler(
    route,
    () => undefined,
  )({
    httpMethod: method,
    resource,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    pathParameters: opts.path ?? null,
    queryStringParameters: opts.query ?? null,
    headers: {},
    requestContext: {
      requestId: 'req',
      authorizer: opts.sub === null ? null : { claims: { sub: opts.sub ?? admin.adminId } },
    },
  } as unknown as APIGatewayProxyEvent).then((r) => ({
    status: r.statusCode,
    body: r.body ? JSON.parse(r.body) : undefined,
  }));

async function upload(resultId: string, pdf: Uint8Array) {
  const spec = { sha256: sha256Base64(pdf), sizeBytes: pdf.byteLength };
  const issued = await app.documents.uploadUrl(resultId, spec, admin);
  const params = new URL(issued.url).searchParams;
  expect(await storage.acceptUpload(params, issued.headers['x-amz-checksum-sha256'], pdf)).toBe(
    true,
  );
  return { spec, issued };
}

async function newResult(folio: string) {
  const patient = await app.patients.create(
    { fullName: 'Paciente Sintética', birthDate: '1990-01-01', folio, phone: '+525500000000' },
    admin,
  );
  const result = await app.results.create(
    { patientId: patient.patientId, resultType: 'PAPANICOLAOU', sampleDate: '2026-01-10' },
    admin,
  );
  return { patient, result };
}

beforeAll(async () => {
  env = await createTestEnv('admin');
  dir = await mkdtemp(join(tmpdir(), 'eira-admin-'));
  storage = new LocalDocumentStorage({
    dir,
    baseUrl: 'http://127.0.0.1:0',
    secret: 's'.repeat(32),
    clock,
  });
  app = buildContainer(
    { ...env.config, minResponseMs: 0 },
    { db: env.db, secrets: env.secrets, sms: new MockSmsProvider(), storage, clock },
  );
});
afterAll(async () => {
  await env.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('administración de expedientes', () => {
  const route = () => adminPatientsRoute(() => app.patients);

  it('alta, búsqueda exacta por folio y consulta sin hashes ni teléfono completo', async () => {
    const created = await call(route(), 'POST', '/v1/admin/patients', {
      body: {
        fullName: 'Ana Sintética',
        birthDate: '1985-02-03',
        folio: 'ADM-0001',
        phone: '+525511112222',
      },
    });
    expect(created.status).toBe(201);
    const found = await call(route(), 'GET', '/v1/admin/patients', {
      query: { folio: 'adm-0001' },
    });
    expect(found.body.patientId).toBe(created.body.patientId);
    const byId = await call(route(), 'GET', '/v1/admin/patients/{patientId}', {
      path: { patientId: created.body.patientId },
    });
    expect(Object.keys(byId.body).sort()).toEqual([
      'createdAt',
      'dataClassification',
      'patientId',
      'phoneMasked',
      'status',
    ]);
    expect(JSON.stringify(byId.body)).not.toContain('11112222');
    const dup = await call(route(), 'POST', '/v1/admin/patients', {
      body: {
        fullName: 'Otra',
        birthDate: '1985-02-03',
        folio: 'ADM-0001',
        phone: '+525511112222',
      },
    });
    expect(dup.status).toBe(409);
  });

  it('sin identidad de Cognito responde 401; folio inexistente 404; ruta desconocida 404', async () => {
    expect(
      (
        await call(route(), 'GET', '/v1/admin/patients', {
          query: { folio: 'ADM-0001' },
          sub: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (await call(route(), 'GET', '/v1/admin/patients', { query: { folio: 'NOPE-9999' } })).status,
    ).toBe(404);
    expect((await call(route(), 'DELETE', '/v1/admin/patients')).status).toBe(404);
  });
});

describe('carga, integridad y revisión de documentos', () => {
  const results = () =>
    adminResultsRoute(
      () => app.results,
      () => app.documents,
    );
  const reviewUrl = () => adminReviewUrlRoute(() => app.documents);

  it('flujo completo: carga verificada → URL de revisión de 60 s → aprobación', async () => {
    const { patient, result } = await newResult('ADM-0002');
    const pdf = syntheticPdf(['Folio: ADM-0002']);
    const { spec, issued } = await upload(result.resultId, pdf);
    expect(issued.expiresIn).toBe(SECURITY_POLICY.uploadUrlTtlSeconds);
    const submitted = await call(results(), 'POST', '/v1/admin/results/{resultId}/submit', {
      path: { resultId: result.resultId },
      body: spec,
    });
    expect(submitted.body).toMatchObject({
      status: 'PENDING_REVIEW',
      version: 1,
      sha256: spec.sha256,
    });
    const url = await call(reviewUrl(), 'POST', '/v1/admin/results/{resultId}/review-url', {
      path: { resultId: result.resultId },
    });
    expect(url.body.expiresIn).toBe(60);
    expect(
      Buffer.from((await storage.open(new URL(url.body.url).searchParams))!).equals(
        Buffer.from(pdf),
      ),
    ).toBe(true);
    const approved = await call(results(), 'POST', '/v1/admin/results/{resultId}/review', {
      path: { resultId: result.resultId },
      body: {
        decision: 'APPROVE',
        checks: { correspondence: true, integrity: true, legibility: true },
      },
    });
    expect(approved.body.status).toBe('APPROVED');
    const listed = await call(results(), 'GET', '/v1/admin/patients/{patientId}/results', {
      path: { patientId: patient.patientId },
    });
    expect(listed.body.results.map((r: { status: string }) => r.status)).toEqual(['APPROVED']);
    expect(JSON.stringify(listed.body)).not.toContain('s3Key');
  });

  it('la URL de revisión solo existe en PENDING_REVIEW y el rechazo queda auditado', async () => {
    const { result } = await newResult('ADM-0003');
    const denied = await call(reviewUrl(), 'POST', '/v1/admin/results/{resultId}/review-url', {
      path: { resultId: result.resultId },
    });
    expect(denied.status).toBe(409);
    const { spec } = await upload(result.resultId, syntheticPdf(['ADM-0003']));
    await app.documents.submit(result.resultId, spec, admin);
    await app.results.review(
      result.resultId,
      { decision: 'APPROVE', checks: { correspondence: true, integrity: true, legibility: true } },
      admin,
    );
    expect(
      (
        await call(reviewUrl(), 'POST', '/v1/admin/results/{resultId}/review-url', {
          path: { resultId: result.resultId },
        })
      ).status,
    ).toBe(409);
    const events = await env.repos.audit.query({
      eventType: 'REVIEW_URL_ISSUED',
      from: new Date(nowMs - 60_000).toISOString(),
      to: new Date(Math.max(nowMs, Date.now()) + 60_000).toISOString(),
    });
    expect(
      events.items.filter((e) => e.resultId === result.resultId).map((e) => e.outcome),
    ).toEqual(['FAILURE', 'FAILURE']);
  });

  it('integridad: sin carga, o con tamaño/SHA-256 distintos, no pasa a revisión', async () => {
    const { result } = await newResult('ADM-0004');
    const pdf = syntheticPdf(['ADM-0004']);
    const spec = { sha256: sha256Base64(pdf), sizeBytes: pdf.byteLength };
    await expect(app.documents.submit(result.resultId, spec, admin)).rejects.toMatchObject({
      statusCode: 409,
    });
    const issued = await app.documents.uploadUrl(result.resultId, spec, admin);
    const params = new URL(issued.url).searchParams;
    const other = syntheticPdf(['otro contenido']);
    expect(await storage.acceptUpload(params, issued.headers['x-amz-checksum-sha256'], other)).toBe(
      false,
    );
    expect(await storage.acceptUpload(params, sha256Base64(other), other)).toBe(false);
    await upload(result.resultId, pdf);
    await expect(
      app.documents.submit(result.resultId, { ...spec, sha256: sha256Base64(other) }, admin),
    ).rejects.toMatchObject({ statusCode: 400 });
    nowMs += (SECURITY_POLICY.uploadUrlTtlSeconds + 1) * 1000;
    expect(await storage.acceptUpload(params, spec.sha256, pdf)).toBe(false);
  });

  it('corrección: nueva versión del PDF, y la anterior deja de ser la referencia', async () => {
    const { result } = await newResult('ADM-0005');
    const v1 = await upload(result.resultId, syntheticPdf(['v1']));
    await app.documents.submit(result.resultId, v1.spec, admin);
    await app.results.review(
      result.resultId,
      {
        decision: 'REQUEST_CORRECTION',
        checks: { correspondence: true, integrity: true, legibility: false },
        note: 'Ilegible',
      },
      admin,
    );
    const v2 = await upload(result.resultId, syntheticPdf(['v2']));
    expect(v2.issued.version).toBe(2);
    const resubmitted = await app.documents.submit(result.resultId, v2.spec, admin);
    expect(resubmitted).toMatchObject({
      status: 'PENDING_REVIEW',
      version: 2,
      sha256: v2.spec.sha256,
    });
    expect((await env.repos.results.get(result.resultId))!.s3Key).toMatch(/\/v2\.pdf$/);
  });

  it('una URL de carga pendiente no reemplaza el documento aprobado', async () => {
    const { result } = await newResult('ADM-0008');
    const pdf = syntheticPdf(['revisado']);
    const spec = { sha256: sha256Base64(pdf), sizeBytes: pdf.byteLength };
    const other = syntheticPdf(['no revisado']);
    const otherSpec = { sha256: sha256Base64(other), sizeBytes: other.byteLength };
    const pending = await app.documents.uploadUrl(result.resultId, otherSpec, admin);
    await upload(result.resultId, pdf);
    await app.documents.submit(result.resultId, spec, admin);
    await app.results.review(
      result.resultId,
      { decision: 'APPROVE', checks: { correspondence: true, integrity: true, legibility: true } },
      admin,
    );
    const params = new URL(pending.url).searchParams;
    expect(await storage.acceptUpload(params, otherSpec.sha256, other)).toBe(false);
    expect(await storage.head((await env.repos.results.get(result.resultId))!.s3Key!)).toEqual(
      spec,
    );
  });

  it('no se emite URL de carga en PENDING_REVIEW ni para resultados inexistentes', async () => {
    const { result } = await newResult('ADM-0006');
    const { spec } = await upload(result.resultId, syntheticPdf(['x']));
    await app.documents.submit(result.resultId, spec, admin);
    await expect(app.documents.uploadUrl(result.resultId, spec, admin)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      app.documents.uploadUrl(`res_${'z'.repeat(22)}`, spec, admin),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('consulta de auditoría', () => {
  it('filtra por expediente, registra AUDIT_QUERIED y no expone datos personales', async () => {
    const { patient } = await newResult('ADM-0007');
    const res = await call(
      adminAuditRoute(() => app.auditQueries),
      'GET',
      '/v1/admin/audit',
      {
        query: {
          patientId: patient.patientId,
          from: new Date(Date.now() - 3600_000).toISOString(),
          to: new Date(Math.max(nowMs, Date.now()) + 60_000).toISOString(),
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['PATIENT_CREATED', 'RESULT_CREATED', 'AUDIT_QUERIED']),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/ADM-0007|Sintética|5500000000/);
  });

  it('exige exactamente un filtro y un rango válido', async () => {
    const res = await call(
      adminAuditRoute(() => app.auditQueries),
      'GET',
      '/v1/admin/audit',
      {
        query: { from: new Date().toISOString(), to: new Date().toISOString() },
      },
    );
    expect(res.status).toBe(400);
  });
});
