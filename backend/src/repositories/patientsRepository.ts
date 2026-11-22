import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Db } from './db.ts';

export type PatientStatus = 'ACTIVE' | 'DISABLED';
export type DataClassification = 'SYNTHETIC' | 'CONFIDENTIAL';

export type PatientRecord = {
  patientId: string;
  folioHash: string;
  nameHash: string;
  birthDateHash: string;
  phoneE164: string;
  status: PatientStatus;
  dataClassification: DataClassification;
  createdAt: string;
  createdBy: string;
  pinWindowStartsAt?: number;
  pinRequestCount?: number;
};

export class PatientsRepository {
  private readonly db: Db;
  private readonly table: string;
  constructor(db: Db, table: string) {
    this.db = db;
    this.table = table;
  }

  /** FolioHashIndex es KEYS_ONLY: devuelve solo los patientId. */
  async findIdsByFolioHash(folioHash: string): Promise<string[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'FolioHashIndex',
        KeyConditionExpression: 'folioHash = :f',
        ExpressionAttributeValues: { ':f': folioHash },
        Limit: 2,
      }),
    );
    return (out.Items ?? []).map((item) => item.patientId as string);
  }

  async get(patientId: string): Promise<PatientRecord | undefined> {
    const out = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { patientId }, ConsistentRead: true }),
    );
    return out.Item as PatientRecord | undefined;
  }

  /** Lectura limitada a los atributos que la política IAM permite al rol. */
  async getAttributes<K extends keyof PatientRecord>(
    patientId: string,
    attributes: readonly K[],
  ): Promise<Pick<PatientRecord, K> | undefined> {
    const names = Object.fromEntries(attributes.map((a, i) => [`#a${i}`, a]));
    const out = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { patientId },
        ProjectionExpression: Object.keys(names).join(', '),
        ExpressionAttributeNames: names,
        ConsistentRead: true,
      }),
    );
    return out.Item as Pick<PatientRecord, K> | undefined;
  }

  /** Alta junto con su evento de auditoría: ambos se escriben o ninguno. */
  async create(record: PatientRecord, auditItem: Record<string, unknown>): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: record,
              ConditionExpression: 'attribute_not_exists(patientId)',
            },
          },
          auditItem,
        ] as never,
      }),
    );
  }
}
