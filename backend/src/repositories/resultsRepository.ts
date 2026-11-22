import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ResultStatus } from '@eira/shared';
import type { Db } from './db.ts';

export type ResultRecord = {
  resultId: string;
  patientId: string;
  resultType: string;
  sampleDate: string;
  status: ResultStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  s3Key?: string;
  sizeBytes?: number;
  sha256?: string;
  availableAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
};

export type PatientIndexItem = Pick<
  ResultRecord,
  'resultId' | 'patientId' | 'createdAt' | 'resultType' | 'status' | 'sampleDate' | 'availableAt'
>;

export const documentKey = (patientId: string, resultId: string, version: number) =>
  `results/${patientId}/${resultId}/v${version}.pdf`;

export class ResultsRepository {
  private readonly db: Db;
  private readonly table: string;
  constructor(db: Db, table: string) {
    this.db = db;
    this.table = table;
  }

  async create(record: ResultRecord): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: record,
        ConditionExpression: 'attribute_not_exists(resultId)',
      }),
    );
  }

  async get(resultId: string): Promise<ResultRecord | undefined> {
    const out = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { resultId }, ConsistentRead: true }),
    );
    return out.Item as ResultRecord | undefined;
  }

  /** PatientIndex no proyecta s3Key: el listado nunca expone la ubicación del documento. */
  async listByPatient(patientId: string, status?: ResultStatus): Promise<PatientIndexItem[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'PatientIndex',
        KeyConditionExpression: 'patientId = :p',
        FilterExpression: status ? '#s = :s' : undefined,
        ExpressionAttributeNames: status ? { '#s': 'status' } : undefined,
        ExpressionAttributeValues: status ? { ':p': patientId, ':s': status } : { ':p': patientId },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );
    return (out.Items ?? []) as PatientIndexItem[];
  }

  /**
   * Transición condicional: solo se aplica si el estado actual es `from` (y la versión
   * coincide, si se indica). Una carrera entre dos administradores deja pasar solo una.
   */
  async transition(params: {
    resultId: string;
    from: ResultStatus;
    to: ResultStatus;
    expectedVersion?: number;
    set?: Record<string, unknown>;
    remove?: string[];
    now: Date;
  }): Promise<void> {
    const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = {
      ':from': params.from,
      ':to': params.to,
      ':now': params.now.toISOString(),
    };
    const sets = ['#status = :to', '#updatedAt = :now'];
    Object.entries(params.set ?? {}).forEach(([key, value], i) => {
      names[`#f${i}`] = key;
      values[`:v${i}`] = value;
      sets.push(`#f${i} = :v${i}`);
    });
    const removes = (params.remove ?? []).map((key, i) => {
      names[`#r${i}`] = key;
      return `#r${i}`;
    });
    let condition = 'attribute_exists(resultId) AND #status = :from';
    if (params.expectedVersion !== undefined) {
      names['#version'] = 'version';
      values[':version'] = params.expectedVersion;
      condition += ' AND #version = :version';
    }
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { resultId: params.resultId },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
}
