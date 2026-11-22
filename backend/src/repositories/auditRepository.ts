import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditEventView } from '@eira/shared';
import { logger } from '../observability/logger.ts';
import type { Db } from './db.ts';

export const AUDIT_EVENT_TYPES = [
  'PIN_REQUESTED',
  'PIN_RESENT',
  'PIN_RATE_LIMITED',
  'PIN_VERIFY_FAIL',
  'SESSION_CREATED',
  'SESSION_REVOKED',
  'RESULTS_LISTED',
  'DOWNLOAD_URL_ISSUED',
  'DOWNLOAD_DENIED',
  'PATIENT_CREATED',
  'PATIENT_VIEWED',
  'RESULT_CREATED',
  'UPLOAD_URL_ISSUED',
  'RESULT_SUBMITTED',
  'REVIEW_URL_ISSUED',
  'RESULT_APPROVED',
  'RESULT_CORRECTION_REQUESTED',
  'AUDIT_QUERIED',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditInput = {
  eventType: AuditEventType;
  outcome: 'SUCCESS' | 'FAILURE';
  actorType: 'PATIENT' | 'ADMIN' | 'SYSTEM';
  actorId?: string | undefined;
  patientId?: string | undefined;
  challengeId?: string | undefined;
  resultId?: string | undefined;
  reasonCode?: string | undefined;
  requestId?: string | undefined;
  sourceIpHash?: string | undefined;
  userAgentHash?: string | undefined;
};

/** Ítem de auditoría con las claves de docs/data-model.md. Solo campos permitidos. */
export function buildAuditItem(input: AuditInput, now: Date) {
  const occurredAt = now.toISOString();
  const eventId = randomUUID();
  return {
    pk: input.patientId ? `PATIENT#${input.patientId}` : `ANON#${occurredAt.slice(0, 10)}`,
    sk: `${occurredAt}#${eventId}`,
    eventId,
    occurredAt,
    eventType: input.eventType,
    outcome: input.outcome,
    actorType: input.actorType,
    actorId: input.actorId,
    patientId: input.patientId,
    challengeId: input.challengeId,
    resultId: input.resultId,
    reasonCode: input.reasonCode,
    requestId: input.requestId,
    sourceIpHash: input.sourceIpHash,
    userAgentHash: input.userAgentHash,
  };
}

/** Condición append-only: un evento nunca sobrescribe otro. */
export const AUDIT_APPEND_CONDITION = 'attribute_not_exists(pk)';

export class AuditRepository {
  private readonly db: Db;
  private readonly table: string;
  constructor(db: Db, table: string) {
    this.db = db;
    this.table = table;
  }

  /** Fail-closed: lanza si no se puede escribir. Usar antes de conceder acceso. */
  async append(input: AuditInput, now = new Date()): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: buildAuditItem(input, now),
        ConditionExpression: AUDIT_APPEND_CONDITION,
      }),
    );
  }

  /** Best-effort para eventos de fallo: nunca interrumpe la respuesta. */
  async tryAppend(input: AuditInput, now = new Date()): Promise<void> {
    try {
      await this.append(input, now);
    } catch (error) {
      logger.error('AuditWriteFailed', { eventType: input.eventType, error: String(error) });
      logger.metric('AuditWriteFailed');
    }
  }

  /** Elemento para incluir en una TransactWriteItems. */
  transactPut(input: AuditInput, now = new Date()) {
    return {
      Put: {
        TableName: this.table,
        Item: buildAuditItem(input, now),
        ConditionExpression: AUDIT_APPEND_CONDITION,
      },
    };
  }

  async query(params: {
    patientId?: string;
    eventType?: string;
    from: string;
    to: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: AuditEventView[]; cursor?: string | undefined }> {
    const byPatient = params.patientId !== undefined;
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: byPatient ? undefined : 'EventTypeIndex',
        KeyConditionExpression: `${byPatient ? 'pk' : 'eventType'} = :key AND sk BETWEEN :from AND :to`,
        ExpressionAttributeValues: {
          ':key': byPatient ? `PATIENT#${params.patientId}` : params.eventType,
          // Mismo formato que occurredAt (con milisegundos) para comparar como cadena.
          ':from': new Date(params.from).toISOString(),
          ':to': `${new Date(params.to).toISOString()}#\uffff`,
        },
        ScanIndexForward: false,
        Limit: params.limit ?? 100,
        ExclusiveStartKey: params.cursor
          ? (JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as Record<
              string,
              unknown
            >)
          : undefined,
      }),
    );
    const items = (out.Items ?? []).map((item) => ({
      eventId: item.eventId as string,
      eventType: item.eventType as string,
      outcome: item.outcome as AuditEventView['outcome'],
      reasonCode: item.reasonCode as string | undefined,
      occurredAt: item.occurredAt as string,
      actorType: item.actorType as AuditEventView['actorType'],
      actorId: item.actorId as string | undefined,
      patientId: item.patientId as string | undefined,
      resultId: item.resultId as string | undefined,
    }));
    const cursor = out.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(out.LastEvaluatedKey), 'utf8').toString('base64url')
      : undefined;
    return { items, cursor };
  }
}
