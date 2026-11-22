import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SECURITY_POLICY } from '@eira/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/app/container.ts';
import { seedSynthetic } from '../../src/local/seed.ts';
import { SYNTHETIC_PATIENTS } from '../../src/local/syntheticData.ts';
import { PatientService } from '../../src/services/patientService.ts';
import { ResultService } from '../../src/services/resultService.ts';
import { MockSmsProvider } from '../../src/sms/SmsProvider.ts';
import { LocalDocumentStorage } from '../../src/storage/DocumentStorage.ts';
import { createTestEnv, type TestEnv } from './localEnv.ts';

const [ANA, BEA, CARMEN] = SYNTHETIC_PATIENTS;
const meta = { requestId: 'req' };
let env: TestEnv;
let app: Container;
let storage: LocalDocumentStorage;
let dir: string;
let nowMs = Date.now();
const clock = () => new Date(nowMs);
const sms = new MockSmsProvider();
let patientIds: Map<string, string>;

async function login(p: { fullName: string; birthDate: string; folio: string }) {
  // Estas pruebas no cubren el límite de SMS: se reinicia el contador del expediente.
  await env.db.send(
    new UpdateCommand({
      TableName: env.config.tables.patients,
      Key: { patientId: patientIds.get(p.folio)! },
      UpdateExpression: 'SET pinRequestCount = :z, pinWindowStartsAt = :z',
      ExpressionAttributeValues: { ':z': 0 },
    }),
  );
  const { challengeId } = await app.access.request(p, meta);
  const pin = /\b(\d{6})\b/.exec(sms.outbox.at(-1)!.message)![1]!;
  const { token } = await app.access.verify({ challengeId, pin }, meta);
  return { token, principal: (await app.sessions.authorize(`Bearer ${token}`))! };
}

beforeAll(async () => {
  env = await createTestEnv('flow');
  dir = await mkdtemp(join(tmpdir(), 'eira-docs-'));
  storage = new LocalDocumentStorage({
    dir,
    baseUrl: 'http://127.0.0.1:0',
    secret: 'd'.repeat(32),
    clock,
  });
  app = buildContainer(
    { ...env.config, minResponseMs: 0 },
    { db: env.db, secrets: env.secrets, sms, storage, clock },
  );
  const deps = { audit: env.repos.audit, clock };
  ({ patientIds } = await seedSynthetic({
    patients: new PatientService({
      ...deps,
      config: env.config,
      patients: env.repos.patients,
      secrets: env.secrets,
    }),
    results: new ResultService({
      ...deps,
      results: env.repos.results,
      patients: env.repos.patients,
    }),
    storage,
  }));
});
afterAll(async () => {
  await env.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('flujo completo de la paciente', () => {
  it('identificación → PIN → listado (solo aprobados propios) → URL de 60 s → PDF', async () => {
    const { principal } = await login(ANA);
    const list = await app.patientResults.list(principal.patientId, meta);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual([
      'availableAt',
      'resultId',
      'resultType',
      'sampleDate',
    ]);
    const { url, expiresIn } = await app.patientResults.downloadUrl(
      principal.patientId,
      list[0]!.resultId,
      meta,
    );
    expect(expiresIn).toBe(SECURITY_POLICY.downloadUrlTtlSeconds);
    const pdf = await storage.open(new URL(url).searchParams);
    expect(Buffer.from(pdf!).toString('latin1')).toMatch(/^%PDF-1\.4[\s\S]*SIN VALOR CLINICO/);
  });

  it('la URL firmada expira a los 60 s y no admite otra clave', async () => {
    const { principal } = await login(BEA);
    const [item] = await app.patientResults.list(principal.patientId, meta);
    const { url } = await app.patientResults.downloadUrl(principal.patientId, item!.resultId, meta);
    const params = new URL(url).searchParams;
    const tampered = new URLSearchParams(params);
    tampered.set('key', params.get('key')!.replace(/v\d+/, 'v9'));
    expect(await storage.open(tampered)).toBeUndefined();
    nowMs += SECURITY_POLICY.downloadUrlTtlSeconds * 1000;
    expect(await storage.open(params)).toBeUndefined();
  });

  it('aislamiento: una paciente no obtiene resultados de otra (mismo 404) y queda auditado', async () => {
    const ana = await login(ANA);
    const bea = await login(BEA);
    const [beaResult] = await app.patientResults.list(bea.principal.patientId, meta);
    await expect(
      app.patientResults.downloadUrl(ana.principal.patientId, beaResult!.resultId, meta),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      app.patientResults.downloadUrl(ana.principal.patientId, `res_${'x'.repeat(22)}`, meta),
    ).rejects.toMatchObject({ statusCode: 404 });
    const denied = await env.repos.audit.query({
      eventType: 'DOWNLOAD_DENIED',
      from: new Date(nowMs - 3600_000).toISOString(),
      to: new Date(nowMs + 60_000).toISOString(),
    });
    expect(denied.items.map((e) => e.reasonCode).sort()).toEqual(['NOT_FOUND', 'NOT_OWNER']);
  });

  it('resultados no aprobados no se listan ni se descargan', async () => {
    const { principal } = await login(ANA);
    const all = await env.repos.results.listByPatient(principal.patientId);
    const pending = all.find((r) => r.status !== 'APPROVED')!;
    expect(
      (await app.patientResults.list(principal.patientId, meta)).map((r) => r.resultId),
    ).not.toContain(pending.resultId);
    await expect(
      app.patientResults.downloadUrl(principal.patientId, pending.resultId, meta),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('paciente sin resultados aprobados recibe una lista vacía', async () => {
    const { principal } = await login(CARMEN);
    expect(await app.patientResults.list(principal.patientId, meta)).toEqual([]);
  });

  it('si la auditoría falla no se emite URL (fail-closed)', async () => {
    const { principal } = await login(ANA);
    const [item] = await app.patientResults.list(principal.patientId, meta);
    const failing = buildContainer(
      { ...env.config, minResponseMs: 0 },
      { db: env.db, secrets: env.secrets, sms, storage, clock },
    );
    failing.audit.append = () => Promise.reject(new Error('audit down'));
    await expect(
      failing.patientResults.downloadUrl(principal.patientId, item!.resultId, meta),
    ).rejects.toThrow('audit down');
  });
});

describe('sesiones', () => {
  it('vence a los 15 minutos', async () => {
    const { token } = await login(ANA);
    nowMs += (SECURITY_POLICY.patientSessionTtlSeconds - 1) * 1000;
    expect(await app.sessions.authorize(`Bearer ${token}`)).toBeDefined();
    nowMs += 1000;
    expect(await app.sessions.authorize(`Bearer ${token}`)).toBeUndefined();
  });

  it('logout revoca la sesión de inmediato y solo esa', async () => {
    const first = await login(ANA);
    const second = await login(ANA);
    await app.sessions.logout(first.principal, meta);
    expect(await app.sessions.authorize(`Bearer ${first.token}`)).toBeUndefined();
    expect(await app.sessions.authorize(`Bearer ${second.token}`)).toEqual(second.principal);
  });

  it('rechaza encabezados mal formados o tokens desconocidos', async () => {
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Basic abc',
      `Bearer ${'a'.repeat(42)}`,
      `Bearer ${'a'.repeat(43)}`,
    ]) {
      expect(await app.sessions.authorize(header)).toBeUndefined();
    }
  });

  it('el contexto del authorizer lleva patientId y hash, nunca el token', async () => {
    const { token, principal } = await login(BEA);
    expect(JSON.stringify(principal)).not.toContain(token);
  });
});
