import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSynthetic } from '../../src/local/seed.ts';
import { SYNTHETIC_PATIENTS } from '../../src/local/syntheticData.ts';
import { buildAuditItem } from '../../src/repositories/auditRepository.ts';
import { PatientService } from '../../src/services/patientService.ts';
import { ResultService } from '../../src/services/resultService.ts';
import { createTestEnv, type TestEnv } from './localEnv.ts';

const admin = { adminId: 'admin-sintetico', requestId: 'req-1' };
let env: TestEnv;
let patients: PatientService;
let results: ResultService;

beforeAll(async () => {
  env = await createTestEnv('biz');
  const clock = () => new Date();
  patients = new PatientService({
    config: env.config,
    patients: env.repos.patients,
    audit: env.repos.audit,
    secrets: env.secrets,
    clock,
  });
  results = new ResultService({
    results: env.repos.results,
    patients: env.repos.patients,
    audit: env.repos.audit,
    clock,
  });
  await seedSynthetic({ patients, results });
});
afterAll(() => env.destroy());

describe('pacientes', () => {
  it('guarda solo hashes de identidad y marca el expediente como sintético', async () => {
    const view = await patients.findByFolio(' sint-0001 ', admin);
    expect(view?.dataClassification).toBe('SYNTHETIC');
    const record = await env.repos.patients.get(view!.patientId);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('SINT-0001');
    expect(serialized).not.toContain('Ana');
    expect(serialized).not.toContain('1985-03-14');
  });

  it('rechaza folios duplicados', async () => {
    await expect(patients.create(SYNTHETIC_PATIENTS[0], admin)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('folio inexistente devuelve undefined', async () => {
    expect(await patients.findByFolio('SINT-9999', admin)).toBeUndefined();
  });
});

describe('resultados y máquina de estados', () => {
  it('no asocia un resultado a un expediente inexistente', async () => {
    await expect(
      results.create(
        {
          patientId: `pat_${'z'.repeat(22)}`,
          resultType: 'PAPANICOLAOU',
          sampleDate: '2026-01-01',
        },
        admin,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rechaza transiciones no permitidas y aprobaciones incompletas', async () => {
    const view = await patients.findByFolio('SINT-0003', admin);
    const created = await results.create(
      { patientId: view!.patientId, resultType: 'PAPANICOLAOU', sampleDate: '2026-02-01' },
      admin,
    );
    const checks = { correspondence: true, integrity: true, legibility: true };
    await expect(
      results.review(created.resultId, { decision: 'APPROVE', checks }, admin),
    ).rejects.toMatchObject({ statusCode: 409 });
    const record = await results.get(created.resultId);
    const pending = await results.applyEvent(record, 'SUBMIT_DOCUMENT', { set: { version: 1 } });
    expect(pending.status).toBe('PENDING_REVIEW');
    await expect(
      results.review(
        created.resultId,
        { decision: 'APPROVE', checks: { ...checks, legibility: false } },
        admin,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const approved = await results.review(created.resultId, { decision: 'APPROVE', checks }, admin);
    expect(approved.status).toBe('APPROVED');
    expect(approved.availableAt).toBeDefined();
  });

  it('dos revisiones concurrentes: solo una se aplica', async () => {
    const view = await patients.findByFolio('SINT-0002', admin);
    const created = await results.create(
      { patientId: view!.patientId, resultType: 'PAPANICOLAOU', sampleDate: '2026-03-01' },
      admin,
    );
    await results.applyEvent(await results.get(created.resultId), 'SUBMIT_DOCUMENT', {
      set: { version: 1 },
    });
    const checks = { correspondence: true, integrity: true, legibility: true };
    const outcomes = await Promise.allSettled([
      results.review(created.resultId, { decision: 'APPROVE', checks }, admin),
      results.review(
        created.resultId,
        { decision: 'REQUEST_CORRECTION', checks, note: 'Ilegible' },
        admin,
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('el listado por paciente no expone la ubicación del documento', async () => {
    const view = await patients.findByFolio('SINT-0001', admin);
    const items = await env.repos.results.listByPatient(view!.patientId);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item).not.toHaveProperty('s3Key');
  });
});

describe('auditoría', () => {
  it('registra eventos sin datos personales', async () => {
    const view = await patients.findByFolio('SINT-0001', admin);
    const out = await env.db.send(
      new QueryCommand({
        TableName: env.config.tables.auditLog,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `PATIENT#${view!.patientId}` },
      }),
    );
    const types = (out.Items ?? []).map((i) => i.eventType);
    expect(types).toEqual(
      expect.arrayContaining(['PATIENT_CREATED', 'RESULT_CREATED', 'PATIENT_VIEWED']),
    );
    const serialized = JSON.stringify(out.Items);
    for (const forbidden of ['SINT-0001', 'Ana', '1985-03-14', '+5255'])
      expect(serialized).not.toContain(forbidden);
  });

  it('attribute_not_exists impide sobrescribir un evento', async () => {
    const item = buildAuditItem(
      { eventType: 'AUDIT_QUERIED', outcome: 'SUCCESS', actorType: 'SYSTEM' },
      new Date(),
    );
    await env.db.send(
      new PutCommand({
        TableName: env.config.tables.auditLog,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    await expect(
      env.db.send(
        new PutCommand({
          TableName: env.config.tables.auditLog,
          Item: { ...item, outcome: 'FAILURE' },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      ),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('consulta por tipo de evento mediante EventTypeIndex', async () => {
    const now = new Date();
    const { items } = await env.repos.audit.query({
      eventType: 'PATIENT_CREATED',
      from: new Date(now.getTime() - 3600_000).toISOString(),
      to: now.toISOString(),
    });
    expect(items).toHaveLength(3);
  });
});
