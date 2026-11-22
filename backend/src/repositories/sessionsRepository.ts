import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Db } from './db.ts';

export type SessionRecord = {
  tokenHash: string;
  patientId: string;
  challengeId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  ttl: number;
};

export class SessionsRepository {
  readonly table: string;
  private readonly db: Db;
  constructor(db: Db, table: string) {
    this.db = db;
    this.table = table;
  }

  async get(tokenHash: string): Promise<SessionRecord | undefined> {
    const out = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { tokenHash }, ConsistentRead: true }),
    );
    return out.Item as SessionRecord | undefined;
  }

  /** Solo toca `revoked` (la política IAM limita los atributos a tokenHash y revoked). */
  async revoke(tokenHash: string): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { tokenHash },
        UpdateExpression: 'SET #revoked = :true',
        ConditionExpression: 'attribute_exists(tokenHash)',
        ExpressionAttributeNames: { '#revoked': 'revoked' },
        ExpressionAttributeValues: { ':true': true },
      }),
    );
  }
}
