import {
  ConditionalCheckFailedException,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLocalTables,
  localClient,
  localTableDefinitions,
  waitForLocal,
} from '../scripts/local-tables.ts';

// Requiere DynamoDB Local (npm run dynamodb:up). Solo datos sintéticos.
const STAGE = `it${Date.now()}`;
const client = localClient();
const table = (name: string) => `eira-${STAGE}-${name}`;

describe('esquema en DynamoDB Local', () => {
  beforeAll(async () => {
    await waitForLocal(client);
    await createLocalTables(client, STAGE);
  });

  afterAll(async () => {
    for (const { input } of localTableDefinitions(STAGE)) {
      await client.send(new DeleteTableCommand({ TableName: input.TableName }));
    }
  });

  it('crea exactamente las cinco tablas de la plantilla', async () => {
    const names = (await client.send(new ListTablesCommand({}))).TableNames!.filter((name) =>
      name.startsWith(`eira-${STAGE}-`),
    );
    expect(names.sort()).toEqual(
      ['AccessSessions', 'AuditLog', 'Patients', 'PinChallenges', 'Results'].map(table),
    );
  });

  it('activa TTL solo en las tablas efímeras', async () => {
    for (const name of ['PinChallenges', 'AccessSessions']) {
      const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: table(name) }));
      expect(ttl.TimeToLiveDescription).toMatchObject({
        AttributeName: 'ttl',
        TimeToLiveStatus: 'ENABLED',
      });
    }
    const patients = await client.send(
      new DescribeTimeToLiveCommand({ TableName: table('Patients') }),
    );
    expect(patients.TimeToLiveDescription?.TimeToLiveStatus).toBe('DISABLED');
  });

  it('FolioHashIndex encuentra al paciente sintético por folioHash', async () => {
    await client.send(
      new PutItemCommand({
        TableName: table('Patients'),
        Item: {
          patientId: { S: 'pat-synthetic-0001' },
          folioHash: { S: 'hmac-folio-synthetic-0001' },
          dataClassification: { S: 'SYNTHETIC' },
        },
      }),
    );
    const res = await client.send(
      new QueryCommand({
        TableName: table('Patients'),
        IndexName: 'FolioHashIndex',
        KeyConditionExpression: 'folioHash = :f',
        ExpressionAttributeValues: { ':f': { S: 'hmac-folio-synthetic-0001' } },
      }),
    );
    expect(res.Items?.map((item) => item.patientId?.S)).toEqual(['pat-synthetic-0001']);
  });

  it('PatientIndex lista resultados por paciente en orden de createdAt', async () => {
    for (const [resultId, createdAt] of [
      ['res-b', '2026-02-01T00:00:00.000Z'],
      ['res-a', '2026-01-01T00:00:00.000Z'],
    ]) {
      await client.send(
        new PutItemCommand({
          TableName: table('Results'),
          Item: {
            resultId: { S: resultId! },
            patientId: { S: 'pat-synthetic-0001' },
            createdAt: { S: createdAt! },
            status: { S: 'AVAILABLE' },
            s3Key: { S: `results/${resultId}.pdf` },
          },
        }),
      );
    }
    const res = await client.send(
      new QueryCommand({
        TableName: table('Results'),
        IndexName: 'PatientIndex',
        KeyConditionExpression: 'patientId = :p',
        ExpressionAttributeValues: { ':p': { S: 'pat-synthetic-0001' } },
      }),
    );
    expect(res.Items?.map((item) => item.resultId?.S)).toEqual(['res-a', 'res-b']);
    // La proyección INCLUDE no expone la clave S3 del documento.
    expect(res.Items?.[0]).not.toHaveProperty('s3Key');
  });

  it('AuditLog admite consultas por paciente y por tipo de evento', async () => {
    const event = (sk: string, eventType: string) => ({
      pk: { S: 'PATIENT#pat-synthetic-0001' },
      sk: { S: sk },
      eventType: { S: eventType },
    });
    await client.send(
      new PutItemCommand({
        TableName: table('AuditLog'),
        Item: event('2026-01-01T00:00:00.000Z#evt-1', 'PIN_REQUESTED'),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    // Un evento repetido no puede sobrescribir otro (append-only en la aplicación).
    await expect(
      client.send(
        new PutItemCommand({
          TableName: table('AuditLog'),
          Item: event('2026-01-01T00:00:00.000Z#evt-1', 'TAMPERED'),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      ),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);

    const byPatient = await client.send(
      new QueryCommand({
        TableName: table('AuditLog'),
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'PATIENT#pat-synthetic-0001' } },
      }),
    );
    expect(byPatient.Items?.map((item) => item.eventType?.S)).toEqual(['PIN_REQUESTED']);

    const byType = await client.send(
      new QueryCommand({
        TableName: table('AuditLog'),
        IndexName: 'EventTypeIndex',
        KeyConditionExpression: 'eventType = :t AND begins_with(sk, :day)',
        ExpressionAttributeValues: { ':t': { S: 'PIN_REQUESTED' }, ':day': { S: '2026-01-01' } },
      }),
    );
    expect(byType.Count).toBe(1);
  });

  it('las claves coinciden con el modelo de datos', async () => {
    const keys = async (name: string) =>
      (await client.send(new DescribeTableCommand({ TableName: table(name) }))).Table!.KeySchema;
    expect(await keys('AccessSessions')).toEqual([{ AttributeName: 'tokenHash', KeyType: 'HASH' }]);
    expect(await keys('PinChallenges')).toEqual([
      { AttributeName: 'challengeId', KeyType: 'HASH' },
    ]);
  });
});
