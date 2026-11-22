import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Db } from './db.ts';

export type ChallengeRecord = {
  challengeId: string;
  kind: 'REAL' | 'DECOY';
  /** Solo en retos REAL. */
  patientId?: string;
  pinHmac: string;
  attempts: number;
  resendCount: number;
  status: 'PENDING' | 'CONSUMED' | 'LOCKED';
  createdAt: number;
  expiresAt: number;
  resendAvailableAt: number;
  ttl: number;
};

/** Las escrituras de retos son condicionales/transaccionales y viven en el servicio de acceso. */
export class ChallengesRepository {
  readonly table: string;
  private readonly db: Db;
  constructor(db: Db, table: string) {
    this.db = db;
    this.table = table;
  }

  async get(challengeId: string): Promise<ChallengeRecord | undefined> {
    const out = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { challengeId }, ConsistentRead: true }),
    );
    return out.Item as ChallengeRecord | undefined;
  }
}
