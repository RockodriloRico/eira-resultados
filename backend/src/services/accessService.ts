import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { type ChallengeResponse, SECURITY_POLICY, type VerifyResponse } from '@eira/shared';
import type { AppConfig } from '../config.ts';
import { clientHash, identityHashes, pinHmac } from '../domain/identity.ts';
import { GENERIC, HttpError } from '../http/responses.ts';
import { logger } from '../observability/logger.ts';
import { randomId, randomPin, randomToken, safeEqual, sha256 } from '../security/crypto.ts';
import type { SecretsProvider } from '../security/secrets.ts';
import type { AuditInput, AuditRepository } from '../repositories/auditRepository.ts';
import type { ChallengeRecord } from '../repositories/challengesRepository.ts';
import { type Db, cancellationCodes, isConditionFailure } from '../repositories/db.ts';
import { pinMessage, type SmsProvider } from '../sms/SmsProvider.ts';
import type { Clock } from './patientService.ts';

const P = SECURITY_POLICY;
const DAY = 24 * 3600;
/** Expediente ficticio para que el camino sin coincidencia haga las mismas lecturas. */
const DUMMY_PATIENT_ID = `pat_${'0'.repeat(22)}`;
const MAX_TX_ATTEMPTS = 3;

export type ClientMeta = {
  requestId?: string | undefined;
  sourceIp?: string | undefined;
  userAgent?: string | undefined;
};

type Deps = {
  config: Pick<AppConfig, 'stage' | 'demoPinEnabled' | 'tables'>;
  db: Db;
  audit: AuditRepository;
  secrets: SecretsProvider;
  sms: SmsProvider;
  clock: Clock;
};

type QuotaUpdate = 'OPEN' | 'CONSUME' | 'EXHAUSTED';

export class AccessService {
  private readonly d: Deps;
  constructor(deps: Deps) {
    this.d = deps;
  }

  private demoPinAllowed(): boolean {
    return (
      this.d.config.demoPinEnabled && this.d.config.stage === 'demo' && this.d.sms.kind === 'mock'
    );
  }

  private challengeResponse(challengeId: string, pin: string): ChallengeResponse {
    const body: ChallengeResponse = {
      challengeId,
      expiresIn: P.pinTtlSeconds,
      resendAfter: P.pinResendCooldownSeconds,
    };
    // En demo se incluye en todas las respuestas (reales y señuelo); ver ADR-0003.
    if (this.demoPinAllowed()) body.demoPin = pin;
    return body;
  }

  private async auditMeta(meta: ClientMeta, secret: string | undefined) {
    return {
      requestId: meta.requestId,
      sourceIpHash: secret ? clientHash(secret, 'ip', meta.sourceIp) : undefined,
      userAgentHash: secret ? clientHash(secret, 'ua', meta.userAgent) : undefined,
    };
  }

  private newChallenge(
    challengeId: string,
    pinHash: string,
    now: number,
    patientId?: string,
  ): ChallengeRecord {
    return {
      challengeId,
      kind: patientId ? 'REAL' : 'DECOY',
      ...(patientId ? { patientId } : {}),
      pinHmac: pinHash,
      attempts: 0,
      resendCount: 0,
      status: 'PENDING',
      createdAt: now,
      expiresAt: now + P.pinTtlSeconds,
      resendAvailableAt: now + P.pinResendCooldownSeconds,
      ttl: now + P.pinTtlSeconds + DAY,
    };
  }

  private quotaUpdate(patientId: string, mode: Exclude<QuotaUpdate, 'EXHAUSTED'>, now: number) {
    const base = { TableName: this.d.config.tables.patients, Key: { patientId } };
    if (mode === 'OPEN') {
      return {
        Update: {
          ...base,
          UpdateExpression: 'SET pinWindowStartsAt = :now, pinRequestCount = :one',
          ConditionExpression:
            'attribute_exists(patientId) AND (attribute_not_exists(pinWindowStartsAt) OR pinWindowStartsAt <= :windowStart)',
          ExpressionAttributeValues: {
            ':now': now,
            ':one': 1,
            ':windowStart': now - P.smsWindowSeconds,
          },
        },
      };
    }
    return {
      Update: {
        ...base,
        UpdateExpression: 'ADD pinRequestCount :one',
        ConditionExpression: 'pinWindowStartsAt > :windowStart AND pinRequestCount < :max',
        ExpressionAttributeValues: {
          ':one': 1,
          ':windowStart': now - P.smsWindowSeconds,
          ':max': P.smsMaxPerWindow,
        },
      },
    };
  }

  private async readQuota(patientId: string, projection: string[]) {
    const out = await this.d.db.send(
      new GetCommand({
        TableName: this.d.config.tables.patients,
        Key: { patientId },
        // Solo los atributos que autoriza IAM (dynamodb:Attributes); #a evita palabras reservadas.
        ProjectionExpression: projection.map((_, i) => `#a${i}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(projection.map((name, i) => [`#a${i}`, name])),
        ConsistentRead: true,
      }),
    );
    return out.Item;
  }

  private static chooseQuota(item: Record<string, unknown> | undefined, now: number): QuotaUpdate {
    const start = item?.pinWindowStartsAt as number | undefined;
    const count = (item?.pinRequestCount as number | undefined) ?? 0;
    if (start === undefined || start <= now - P.smsWindowSeconds) return 'OPEN';
    return count < P.smsMaxPerWindow ? 'CONSUME' : 'EXHAUSTED';
  }

  /**
   * Ejecuta [contador del paciente, escritura del reto, auditoría] en una sola transacción.
   * Devuelve false si el cupo se agotó. Las condiciones del contador garantizan ≤5 por ventana.
   */
  private async consumeQuotaWith(
    patientId: string,
    initial: Record<string, unknown> | undefined,
    projection: string[],
    items: (now: number) => Record<string, unknown>[],
    now: number,
  ): Promise<'OK' | 'EXHAUSTED' | 'CHALLENGE_REJECTED'> {
    let state = initial;
    for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt += 1) {
      const mode = AccessService.chooseQuota(state, now);
      if (mode === 'EXHAUSTED') return 'EXHAUSTED';
      try {
        await this.d.db.send(
          new TransactWriteCommand({
            TransactItems: [this.quotaUpdate(patientId, mode, now), ...items(now)] as never,
          }),
        );
        return 'OK';
      } catch (error) {
        const codes = cancellationCodes(error);
        if (!codes) throw error;
        if (codes[1] === 'ConditionalCheckFailed') return 'CHALLENGE_REJECTED';
        if (codes.includes('TransactionConflict'))
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
        state = await this.readQuota(patientId, projection);
      }
    }
    return 'EXHAUSTED';
  }

  private async sendSms(phone: string, pin: string) {
    try {
      await this.d.sms.send(phone, pinMessage(pin));
    } catch (error) {
      // El cupo no se devuelve (falla en el lado seguro).
      logger.error('SmsSendFailed', { error: String(error) });
      logger.metric('SmsSendFailed');
    }
  }

  // ------------------------------------------------------------------ request
  async request(
    input: { fullName: string; birthDate: string; folio: string },
    meta: ClientMeta,
  ): Promise<ChallengeResponse> {
    const { identity, pin: pinSecret } = await this.d.secrets.get();
    const now = Math.floor(this.d.clock().getTime() / 1000);
    const hashes = identityHashes(identity, input);
    const audit = await this.auditMeta(meta, identity);

    const query = await this.d.db.send(
      new QueryCommand({
        TableName: this.d.config.tables.patients,
        IndexName: 'FolioHashIndex',
        KeyConditionExpression: 'folioHash = :f',
        ExpressionAttributeValues: { ':f': hashes.folioHash },
        Limit: 1,
      }),
    );
    const foundId = query.Items?.[0]?.patientId as string | undefined;
    const patient = (
      await this.d.db.send(
        new GetCommand({
          TableName: this.d.config.tables.patients,
          Key: { patientId: foundId ?? DUMMY_PATIENT_ID },
          ConsistentRead: true,
        }),
      )
    ).Item;
    // Siempre se comparan los dos hashes (contra valores ficticios si no hay expediente).
    const nameOk = safeEqual(
      hashes.nameHash,
      (patient?.nameHash as string | undefined) ?? hashes.folioHash,
    );
    const birthOk = safeEqual(
      hashes.birthDateHash,
      (patient?.birthDateHash as string | undefined) ?? hashes.folioHash,
    );

    const challengeId = randomId();
    const pin = randomPin();
    const pinHash = pinHmac(pinSecret, challengeId, pin);

    let reason: string | undefined;
    if (!patient || !foundId) reason = 'NOT_FOUND';
    else if (!nameOk || !birthOk) reason = 'MISMATCH';
    else if (patient.status !== 'ACTIVE') reason = 'DISABLED';
    else if (this.d.config.stage === 'demo' && patient.dataClassification !== 'SYNTHETIC') {
      reason = 'NON_SYNTHETIC';
      logger.metric('NonSyntheticRecordInDemo');
    }

    if (!reason && foundId && patient) {
      const realItems = (ts: number) => [
        {
          Put: {
            TableName: this.d.config.tables.pinChallenges,
            Item: this.newChallenge(challengeId, pinHash, ts, foundId),
            ConditionExpression: 'attribute_not_exists(challengeId)',
          },
        },
        this.d.audit.transactPut({
          eventType: 'PIN_REQUESTED',
          outcome: 'SUCCESS',
          actorType: 'PATIENT',
          patientId: foundId,
          challengeId,
          ...audit,
        }),
      ];
      const outcome = await this.consumeQuotaWith(
        foundId,
        patient,
        ['pinWindowStartsAt', 'pinRequestCount'],
        realItems,
        now,
      );
      if (outcome === 'OK') {
        await this.sendSms(patient.phoneE164 as string, pin);
        return this.challengeResponse(challengeId, pin);
      }
      reason = 'RATE_LIMITED';
    }

    // Señuelo: mismo esquema, sin patientId, PIN desconocido para todos salvo demoPin en demo.
    const decoyPin = reason === 'RATE_LIMITED' ? randomPin() : pin;
    await this.d.db.send(
      new PutCommand({
        TableName: this.d.config.tables.pinChallenges,
        Item: this.newChallenge(challengeId, pinHmac(pinSecret, challengeId, decoyPin), now),
        ConditionExpression: 'attribute_not_exists(challengeId)',
      }),
    );
    const known =
      reason === 'DISABLED' ||
      reason === 'RATE_LIMITED' ||
      reason === 'MISMATCH' ||
      reason === 'NON_SYNTHETIC';
    await this.d.audit.tryAppend({
      eventType: reason === 'RATE_LIMITED' ? 'PIN_RATE_LIMITED' : 'PIN_REQUESTED',
      outcome: 'FAILURE',
      actorType: 'PATIENT',
      ...(known && foundId ? { patientId: foundId } : {}),
      challengeId,
      reasonCode: reason,
      ...audit,
    });
    return this.challengeResponse(challengeId, decoyPin);
  }

  // ------------------------------------------------------------------ resend
  async resend(challengeId: string, meta: ClientMeta): Promise<ChallengeResponse> {
    const { pin: pinSecret } = await this.d.secrets.get();
    const now = Math.floor(this.d.clock().getTime() / 1000);
    const audit = await this.auditMeta(meta, undefined);
    const challenge = (
      await this.d.db.send(
        new GetCommand({
          TableName: this.d.config.tables.pinChallenges,
          Key: { challengeId },
          ConsistentRead: true,
        }),
      )
    ).Item as ChallengeRecord | undefined;
    if (
      !challenge ||
      challenge.status !== 'PENDING' ||
      challenge.expiresAt <= now ||
      challenge.resendCount >= P.pinMaxResends
    ) {
      throw new HttpError(400, GENERIC.invalidCode);
    }
    if (challenge.resendAvailableAt > now)
      throw new HttpError(429, 'Espera antes de solicitar otro código');

    const pin = randomPin();
    const update = (pinHash: string, ts: number) => ({
      Update: {
        TableName: this.d.config.tables.pinChallenges,
        Key: { challengeId },
        UpdateExpression:
          'SET pinHmac = :h, expiresAt = :exp, resendAvailableAt = :next, #ttl = :ttl ADD resendCount :one',
        ConditionExpression:
          '#status = :pending AND expiresAt > :now AND resendAvailableAt <= :now AND resendCount < :maxResends',
        ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':h': pinHash,
          ':exp': ts + P.pinTtlSeconds,
          ':next': ts + P.pinResendCooldownSeconds,
          ':ttl': ts + P.pinTtlSeconds + DAY,
          ':one': 1,
          ':pending': 'PENDING',
          ':now': ts,
          ':maxResends': P.pinMaxResends,
        },
      },
    });

    const projection = [
      'patientId',
      'phoneE164',
      'status',
      'dataClassification',
      'pinWindowStartsAt',
      'pinRequestCount',
    ];
    if (challenge.kind === 'REAL' && challenge.patientId) {
      const patientId = challenge.patientId;
      const patient = await this.readQuota(patientId, projection);
      const eligible =
        patient?.status === 'ACTIVE' &&
        (this.d.config.stage !== 'demo' || patient.dataClassification === 'SYNTHETIC');
      if (eligible && patient) {
        const outcome = await this.consumeQuotaWith(
          patientId,
          patient,
          projection,
          (ts) => [update(pinHmac(pinSecret, challengeId, pin), ts)],
          now,
        );
        if (outcome === 'OK') {
          await this.sendSms(patient.phoneE164 as string, pin);
          await this.d.audit.tryAppend({
            eventType: 'PIN_RESENT',
            outcome: 'SUCCESS',
            actorType: 'PATIENT',
            patientId,
            challengeId,
            ...audit,
          });
          return this.challengeResponse(challengeId, pin);
        }
        if (outcome === 'CHALLENGE_REJECTED') throw new HttpError(400, GENERIC.invalidCode);
      }
      // Sin cupo: se sustituye el PIN por uno que nadie conoce y no se envía SMS (falla cerrado).
      const unknownPin = randomPin();
      await this.applyDecoyResend(update(pinHmac(pinSecret, challengeId, unknownPin), now));
      await this.d.audit.tryAppend({
        eventType: 'PIN_RATE_LIMITED',
        outcome: 'FAILURE',
        actorType: 'PATIENT',
        patientId,
        challengeId,
        reasonCode: eligible ? 'RATE_LIMITED' : 'DISABLED',
        ...audit,
      });
      // demoPin también aleatorio y distinto del guardado: en demo tampoco permite entrar.
      return this.challengeResponse(challengeId, randomPin());
    }

    await this.applyDecoyResend(update(pinHmac(pinSecret, challengeId, pin), now));
    await this.d.audit.tryAppend({
      eventType: 'PIN_RESENT',
      outcome: 'FAILURE',
      actorType: 'PATIENT',
      challengeId,
      reasonCode: 'DECOY',
      ...audit,
    });
    return this.challengeResponse(challengeId, pin);
  }

  private async applyDecoyResend(item: { Update: Record<string, unknown> }) {
    try {
      await this.d.db.send(new UpdateCommand(item.Update as never));
    } catch (error) {
      if (isConditionFailure(error)) throw new HttpError(400, GENERIC.invalidCode);
      throw error;
    }
  }

  // ------------------------------------------------------------------ verify
  async verify(
    input: { challengeId: string; pin: string },
    meta: ClientMeta,
  ): Promise<VerifyResponse> {
    const { pin: pinSecret, identity } = await this.d.secrets.get();
    const now = Math.floor(this.d.clock().getTime() / 1000);
    const audit = await this.auditMeta(meta, identity);
    const { challengeId } = input;
    const table = this.d.config.tables.pinChallenges;
    const challenge = (
      await this.d.db.send(
        new GetCommand({ TableName: table, Key: { challengeId }, ConsistentRead: true }),
      )
    ).Item as ChallengeRecord | undefined;
    const computed = pinHmac(pinSecret, challengeId, input.pin);
    const matches = challenge !== undefined && safeEqual(computed, challenge.pinHmac);

    if (matches && challenge.kind === 'REAL' && challenge.patientId) {
      const token = randomToken();
      const tokenHash = sha256(token);
      const patientId = challenge.patientId;
      for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt += 1) {
        try {
          await this.d.db.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: table,
                    Key: { challengeId },
                    UpdateExpression: 'SET #status = :consumed, usedAt = :now',
                    ConditionExpression:
                      '#status = :pending AND attempts < :max AND expiresAt > :now AND pinHmac = :computed AND attribute_exists(patientId)',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                      ':consumed': 'CONSUMED',
                      ':pending': 'PENDING',
                      ':max': P.pinMaxAttempts,
                      ':now': now,
                      ':computed': computed,
                    },
                  },
                },
                {
                  Put: {
                    TableName: this.d.config.tables.accessSessions,
                    Item: {
                      tokenHash,
                      patientId,
                      challengeId,
                      createdAt: now,
                      expiresAt: now + P.patientSessionTtlSeconds,
                      revoked: false,
                      ttl: now + P.patientSessionTtlSeconds + DAY,
                    },
                    ConditionExpression: 'attribute_not_exists(tokenHash)',
                  },
                },
                this.d.audit.transactPut({
                  eventType: 'SESSION_CREATED',
                  outcome: 'SUCCESS',
                  actorType: 'PATIENT',
                  patientId,
                  challengeId,
                  ...audit,
                }),
              ] as never,
            }),
          );
          return { token, expiresIn: P.patientSessionTtlSeconds };
        } catch (error) {
          const codes = cancellationCodes(error);
          if (!codes) throw error;
          if (codes.includes('ConditionalCheckFailed') || !codes.includes('TransactionConflict'))
            break;
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
        }
      }
    }
    return this.registerFailure(challenge, now, audit);
  }

  private async registerFailure(
    challenge: ChallengeRecord | undefined,
    now: number,
    audit: Partial<AuditInput>,
  ): Promise<never> {
    if (!challenge) throw new HttpError(401, GENERIC.invalidCode);
    const table = this.d.config.tables.pinChallenges;
    const auditBase = {
      eventType: 'PIN_VERIFY_FAIL' as const,
      outcome: 'FAILURE' as const,
      actorType: 'PATIENT' as const,
      ...(challenge.patientId ? { patientId: challenge.patientId } : {}),
      challengeId: challenge.challengeId,
      ...audit,
    };
    let attempts: number;
    try {
      const out = await this.d.db.send(
        new UpdateCommand({
          TableName: table,
          Key: { challengeId: challenge.challengeId },
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression: '#status = :pending AND attempts < :max AND expiresAt > :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':pending': 'PENDING',
            ':max': P.pinMaxAttempts,
            ':now': now,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      attempts = out.Attributes?.attempts as number;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const locked = challenge.status === 'LOCKED' || challenge.attempts >= P.pinMaxAttempts;
      logger.metric('PinVerifyFailed');
      await this.d.audit.tryAppend({ ...auditBase, reasonCode: locked ? 'LOCKED' : 'EXPIRED' });
      throw new HttpError(
        locked ? 423 : 401,
        locked ? 'Demasiados intentos. Solicita un código nuevo.' : GENERIC.invalidCode,
      );
    }
    if (attempts >= P.pinMaxAttempts) {
      await this.d.db
        .send(
          new UpdateCommand({
            TableName: table,
            Key: { challengeId: challenge.challengeId },
            UpdateExpression: 'SET #status = :locked',
            ConditionExpression: '#status = :pending AND attempts >= :max',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':locked': 'LOCKED',
              ':pending': 'PENDING',
              ':max': P.pinMaxAttempts,
            },
          }),
        )
        .catch((error: unknown) => {
          if (!isConditionFailure(error)) throw error;
        });
      logger.metric('PinVerifyFailed');
      logger.metric('PinChallengeLocked');
      await this.d.audit.tryAppend({ ...auditBase, reasonCode: 'LOCKED' });
      throw new HttpError(423, 'Demasiados intentos. Solicita un código nuevo.');
    }
    logger.metric('PinVerifyFailed');
    await this.d.audit.tryAppend({ ...auditBase, reasonCode: 'MISMATCH' });
    throw new HttpError(401, GENERIC.invalidCode);
  }
}
