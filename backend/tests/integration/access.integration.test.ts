import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SECURITY_POLICY } from '@eira/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/app/container.ts';
import { requestRoute, verifyRoute } from '../../src/http/accessRoutes.ts';
import { httpHandler } from '../../src/http/handler.ts';
import { SYNTHETIC_PATIENTS } from '../../src/local/syntheticData.ts';
import { sha256 } from '../../src/security/crypto.ts';
import { PatientService } from '../../src/services/patientService.ts';
import { MockSmsProvider } from '../../src/sms/SmsProvider.ts';
import { createTestEnv, type TestEnv } from './localEnv.ts';

const ANA = SYNTHETIC_PATIENTS[0];
const BEA = SYNTHETIC_PATIENTS[1];
const anaIdentity = { fullName: ANA.fullName, birthDate: ANA.birthDate, folio: ANA.folio };
const meta = { requestId: 'req', sourceIp: '203.0.113.10', userAgent: 'vitest' };
const PIN_RE = /\b(\d{6})\b/;

let env: TestEnv;
// Reloj basado en la hora real: DynamoDB Local aplica TTL y borraría retos con fechas pasadas.
let nowMs = Date.now();
const clock = () => new Date(nowMs);
const advance = (seconds: number) => {
  nowMs += seconds * 1000;
};
let sms: MockSmsProvider;
let app: Container;
const ids = new Map<string, string>();

function containerFor(stage: 'local' | 'demo', demoPinEnabled = false) {
  return buildContainer(
    { ...env.config, stage, demoPinEnabled, minResponseMs: 0 },
    { db: env.db, secrets: env.secrets, sms, clock },
  );
}
const lastPin = () => PIN_RE.exec(sms.outbox.at(-1)!.message)![1]!;
const event = (body: unknown) =>
  ({
    body: JSON.stringify(body),
    requestContext: { requestId: 'r' },
    headers: {},
  }) as unknown as APIGatewayProxyEvent;

async function resetQuota(
  patientId: string,
  fields: Record<string, number> = { pinRequestCount: 0, pinWindowStartsAt: 0 },
) {
  await env.db.send(
    new UpdateCommand({
      TableName: env.config.tables.patients,
      Key: { patientId },
      UpdateExpression: 'SET pinRequestCount = :c, pinWindowStartsAt = :s',
      ExpressionAttributeValues: { ':c': fields.pinRequestCount, ':s': fields.pinWindowStartsAt },
    }),
  );
}
const getPatient = async (id: string) =>
  (
    await env.db.send(
      new GetCommand({
        TableName: env.config.tables.patients,
        Key: { patientId: id },
        ConsistentRead: true,
      }),
    )
  ).Item!;
const getChallenge = async (id: string) =>
  (
    await env.db.send(
      new GetCommand({
        TableName: env.config.tables.pinChallenges,
        Key: { challengeId: id },
        ConsistentRead: true,
      }),
    )
  ).Item!;
const scan = async (table: string) =>
  (await env.db.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? [];
const sessionsFor = async (challengeId: string) =>
  (await scan(env.config.tables.accessSessions)).filter((s) => s.challengeId === challengeId);

beforeAll(async () => {
  env = await createTestEnv('acc');
  const patients = new PatientService({
    config: env.config,
    patients: env.repos.patients,
    audit: env.repos.audit,
    secrets: env.secrets,
    clock,
  });
  for (const p of SYNTHETIC_PATIENTS)
    ids.set(p.folio, (await patients.create(p, { adminId: 'seed' })).patientId);
});
afterAll(() => env.destroy());
beforeEach(async () => {
  sms = new MockSmsProvider();
  app = containerFor('local');
  advance(4000);
  for (const id of ids.values()) await resetQuota(id);
});

describe('solicitud de PIN', () => {
  it('expediente válido: 202, un SMS solo con el código, reto real sin PIN en claro', async () => {
    const res = await app.access.request(anaIdentity, meta);
    expect(Object.keys(res).sort()).toEqual(['challengeId', 'expiresIn', 'resendAfter']);
    expect(sms.outbox).toHaveLength(1);
    expect(sms.outbox[0]!.phone).toBe(ANA.phone);
    const pin = lastPin();
    expect(sms.outbox[0]!.message).not.toMatch(/papanicolaou|resultado|SINT-|Ana/i);
    const challenge = await getChallenge(res.challengeId);
    expect(challenge).toMatchObject({
      kind: 'REAL',
      patientId: ids.get(ANA.folio),
      attempts: 0,
      status: 'PENDING',
    });
    expect(JSON.stringify(challenge)).not.toContain(pin);
    expect((await getPatient(ids.get(ANA.folio)!)).pinRequestCount).toBe(1);
  });

  it('expediente real e inexistente producen respuestas HTTP equivalentes; el señuelo no envía SMS', async () => {
    const handler = httpHandler(
      requestRoute(
        () => app.access,
        () => 0,
      ),
      () => 'https://demo.example',
    );
    const real = await handler(event(anaIdentity));
    const fake = await handler(event({ ...anaIdentity, folio: 'SINT-9999' }));
    const mismatch = await handler(event({ ...anaIdentity, birthDate: '1985-03-15' }));
    for (const r of [real, fake, mismatch]) {
      expect(r.statusCode).toBe(202);
      expect(r.headers).toEqual(real.headers);
      expect(Object.keys(JSON.parse(r.body)).sort()).toEqual(
        Object.keys(JSON.parse(real.body)).sort(),
      );
      expect(r.body.length).toBe(real.body.length);
    }
    expect(sms.outbox).toHaveLength(1);
    const decoy = await getChallenge(JSON.parse(fake.body).challengeId);
    expect(decoy.kind).toBe('DECOY');
    expect(decoy.patientId).toBeUndefined();
  });

  it('expediente deshabilitado responde igual y no envía SMS', async () => {
    const id = ids.get(BEA.folio)!;
    await env.db.send(
      new UpdateCommand({
        TableName: env.config.tables.patients,
        Key: { patientId: id },
        UpdateExpression: 'SET #s = :d',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':d': 'DISABLED' },
      }),
    );
    const res = await app.access.request(BEA, meta);
    expect(res.challengeId).toHaveLength(22);
    expect(sms.outbox).toHaveLength(0);
    await env.db.send(
      new UpdateCommand({
        TableName: env.config.tables.patients,
        Key: { patientId: id },
        UpdateExpression: 'SET #s = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':a': 'ACTIVE' },
      }),
    );
  });

  it('demoPin solo en demo + mock, en retos reales y señuelo; el señuelo nunca crea sesión', async () => {
    expect((await app.access.request(anaIdentity, meta)).demoPin).toBeUndefined();
    const demo = containerFor('demo', true);
    const real = await demo.access.request(anaIdentity, meta);
    expect(real.demoPin).toBe(lastPin());
    const decoy = await demo.access.request({ ...anaIdentity, folio: 'SINT-9999' }, meta);
    expect(decoy.demoPin).toMatch(/^\d{6}$/);
    await expect(
      demo.access.verify({ challengeId: decoy.challengeId, pin: decoy.demoPin! }, meta),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await sessionsFor(decoy.challengeId)).toHaveLength(0);
  });

  it('20 solicitudes concurrentes: exactamente 5 SMS y contador en 5', async () => {
    const out = await Promise.all(
      Array.from({ length: 20 }, () => app.access.request(anaIdentity, meta)),
    );
    expect(out.every((r) => r.challengeId.length === 22)).toBe(true);
    expect(sms.outbox).toHaveLength(SECURITY_POLICY.smsMaxPerWindow);
    expect((await getPatient(ids.get(ANA.folio)!)).pinRequestCount).toBe(5);
    const challenges = await Promise.all(out.map((r) => getChallenge(r.challengeId)));
    expect(challenges.filter((c) => c.kind === 'REAL')).toHaveLength(5);
  });

  it('apertura concurrente de ventana vencida: una sola ventana nueva y máximo 5 SMS', async () => {
    const id = ids.get(ANA.folio)!;
    const nowS = Math.floor(nowMs / 1000);
    await resetQuota(id, {
      pinRequestCount: 5,
      pinWindowStartsAt: nowS - SECURITY_POLICY.smsWindowSeconds - 1,
    });
    await Promise.all(Array.from({ length: 15 }, () => app.access.request(anaIdentity, meta)));
    const p = await getPatient(id);
    expect(p.pinWindowStartsAt).toBe(nowS);
    expect(p.pinRequestCount).toBe(5);
    expect(sms.outbox).toHaveLength(5);
  });

  it('la ventana fija se reinicia después de 3600 s', async () => {
    for (let i = 0; i < 6; i += 1) await app.access.request(anaIdentity, meta);
    expect(sms.outbox).toHaveLength(5);
    advance(SECURITY_POLICY.smsWindowSeconds);
    await app.access.request(anaIdentity, meta);
    expect(sms.outbox).toHaveLength(6);
    expect((await getPatient(ids.get(ANA.folio)!)).pinRequestCount).toBe(1);
  });
});

describe('demoPin en reenvíos rechazados', () => {
  it('un reenvío de expediente deshabilitado no devuelve un PIN válido', async () => {
    const demo = containerFor('demo', true);
    const id = ids.get(BEA.folio)!;
    const res = await demo.access.request(BEA, meta);
    const setStatus = (status: string) =>
      env.db.send(
        new UpdateCommand({
          TableName: env.config.tables.patients,
          Key: { patientId: id },
          UpdateExpression: 'SET #s = :v',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':v': status },
        }),
      );
    await setStatus('DISABLED');
    advance(SECURITY_POLICY.pinResendCooldownSeconds);
    const resent = await demo.access.resend(res.challengeId, meta);
    await setStatus('ACTIVE');
    await expect(
      demo.access.verify({ challengeId: res.challengeId, pin: resent.demoPin! }, meta),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      demo.access.verify({ challengeId: res.challengeId, pin: res.demoPin! }, meta),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await sessionsFor(res.challengeId)).toHaveLength(0);
  });
});

describe('verificación', () => {
  it('PIN correcto crea una sesión de 15 min; solo se guarda el hash del token', async () => {
    const { challengeId } = await app.access.request(anaIdentity, meta);
    const res = await app.access.verify({ challengeId, pin: lastPin() }, meta);
    expect(res.expiresIn).toBe(SECURITY_POLICY.patientSessionTtlSeconds);
    const [session] = await sessionsFor(challengeId);
    expect(session!.tokenHash).toBe(sha256(res.token));
    expect(JSON.stringify(session)).not.toContain(res.token);
    expect(session!.expiresAt - session!.createdAt).toBe(900);
    await expect(app.access.verify({ challengeId, pin: lastPin() }, meta)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('20 intentos fallidos concurrentes: 5 intentos como máximo y bloqueo', async () => {
    const { challengeId } = await app.access.request(anaIdentity, meta);
    const pin = lastPin();
    const wrong = pin === '000000' ? '111111' : '000000';
    const out = await Promise.allSettled(
      Array.from({ length: 20 }, () => app.access.verify({ challengeId, pin: wrong }, meta)),
    );
    expect(out.every((o) => o.status === 'rejected')).toBe(true);
    const c = await getChallenge(challengeId);
    expect(c.attempts).toBe(5);
    expect(c.status).toBe('LOCKED');
    await expect(app.access.verify({ challengeId, pin }, meta)).rejects.toMatchObject({
      statusCode: 423,
    });
    expect(await sessionsFor(challengeId)).toHaveLength(0);
  });

  it('10 verificaciones correctas concurrentes: una sola sesión', async () => {
    const { challengeId } = await app.access.request(anaIdentity, meta);
    const pin = lastPin();
    const out = await Promise.allSettled(
      Array.from({ length: 10 }, () => app.access.verify({ challengeId, pin }, meta)),
    );
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await sessionsFor(challengeId)).toHaveLength(1);
  });

  it('el PIN vence a los 5 minutos', async () => {
    const { challengeId } = await app.access.request(anaIdentity, meta);
    advance(SECURITY_POLICY.pinTtlSeconds);
    await expect(app.access.verify({ challengeId, pin: lastPin() }, meta)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('el handler responde 400 genérico a cuerpos inválidos', async () => {
    const handler = httpHandler(
      verifyRoute(() => app.access),
      () => undefined,
    );
    const res = await handler(event({ challengeId: 'x', pin: '12' }));
    expect(res.statusCode).toBe(400);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
  });
});

describe('reenvío', () => {
  it('antes de 60 s se rechaza; después invalida el PIN anterior y no reinicia intentos', async () => {
    const { challengeId } = await app.access.request(anaIdentity, meta);
    const oldPin = lastPin();
    await expect(app.access.resend(challengeId, meta)).rejects.toMatchObject({ statusCode: 429 });
    const wrong = oldPin === '000000' ? '111111' : '000000';
    await expect(app.access.verify({ challengeId, pin: wrong }, meta)).rejects.toMatchObject({
      statusCode: 401,
    });
    advance(SECURITY_POLICY.pinResendCooldownSeconds);
    const res = await app.access.resend(challengeId, meta);
    expect(res.challengeId).toBe(challengeId);
    expect(sms.outbox).toHaveLength(2);
    const newPin = lastPin();
    expect((await getChallenge(challengeId)).attempts).toBe(1);
    if (newPin !== oldPin) {
      await expect(app.access.verify({ challengeId, pin: oldPin }, meta)).rejects.toMatchObject({
        statusCode: 401,
      });
    }
    await expect(app.access.verify({ challengeId, pin: newPin }, meta)).resolves.toHaveProperty(
      'token',
    );
  });

  it('solicitudes y reenvíos comparten el cupo de 5 SMS', async () => {
    const challenges = [];
    for (let i = 0; i < 4; i += 1)
      challenges.push((await app.access.request(anaIdentity, meta)).challengeId);
    advance(SECURITY_POLICY.pinResendCooldownSeconds);
    await Promise.all(challenges.map((id) => app.access.resend(id, meta)));
    expect(sms.outbox).toHaveLength(5);
    expect((await getPatient(ids.get(ANA.folio)!)).pinRequestCount).toBe(5);
  });

  it('reenvío de un señuelo no envía SMS y mantiene el esquema', async () => {
    const decoy = await app.access.request({ ...anaIdentity, folio: 'SINT-9999' }, meta);
    advance(SECURITY_POLICY.pinResendCooldownSeconds);
    const res = await app.access.resend(decoy.challengeId, meta);
    expect(Object.keys(res).sort()).toEqual(['challengeId', 'expiresIn', 'resendAfter']);
    expect(sms.outbox).toHaveLength(0);
  });

  it('el reenvío sin cupo no envía SMS e invalida el PIN anterior', async () => {
    const { challengeId } = await app.access.request(anaIdentity, meta);
    const pin = lastPin();
    await resetQuota(ids.get(ANA.folio)!, {
      pinRequestCount: 5,
      pinWindowStartsAt: Math.floor(nowMs / 1000),
    });
    advance(SECURITY_POLICY.pinResendCooldownSeconds);
    await app.access.resend(challengeId, meta);
    expect(sms.outbox).toHaveLength(1);
    await expect(app.access.verify({ challengeId, pin }, meta)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('verificación concurrente con reenvío: nunca hay sesión con un PIN ya reemplazado', async () => {
    for (let round = 0; round < 5; round += 1) {
      await resetQuota(ids.get(ANA.folio)!);
      const { challengeId } = await app.access.request(anaIdentity, meta);
      const oldPin = lastPin();
      advance(SECURITY_POLICY.pinResendCooldownSeconds);
      const [verify, resend] = await Promise.allSettled([
        app.access.verify({ challengeId, pin: oldPin }, meta),
        app.access.resend(challengeId, meta),
      ]);
      const sessions = await sessionsFor(challengeId);
      expect(sessions.length).toBeLessThanOrEqual(1);
      // Si el reenvío confirmó un PIN nuevo, la verificación con el viejo debió fallar, y viceversa.
      expect(
        verify.status === 'fulfilled' &&
          resend.status === 'fulfilled' &&
          sms.outbox.length > round * 2 + 1,
      ).toBe(false);
    }
  });
});

describe('auditoría', () => {
  it('no registra PIN, token, teléfono, nombre, fecha ni folio', async () => {
    const res = await containerFor('demo', true).access.request(anaIdentity, meta);
    const { token } = await app.access.verify(
      { challengeId: res.challengeId, pin: res.demoPin! },
      meta,
    );
    const dump = JSON.stringify(await scan(env.config.tables.auditLog));
    for (const value of [
      res.demoPin!,
      token,
      ANA.phone,
      ANA.fullName,
      ANA.birthDate,
      ANA.folio,
      meta.sourceIp,
    ]) {
      expect(dump).not.toContain(value);
    }
    expect(dump).toContain('SESSION_CREATED');
    expect(dump).toContain('PIN_RATE_LIMITED');
  });
});
