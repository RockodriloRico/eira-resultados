import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { loadTemplate, resourcesOfType, subStage } from '../tests/cfn.ts';

// Solo DynamoDB Local: endpoint 127.0.0.1 y credenciales ficticias que DynamoDB Local acepta.
// Nunca apunta a AWS ni lee perfiles o credenciales del equipo.
export const LOCAL_ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8000';
export const LOCAL_STAGE = 'local';

export function localClient(): DynamoDBClient {
  const url = new URL(LOCAL_ENDPOINT);
  if (!['127.0.0.1', 'localhost', 'dynamodb-local'].includes(url.hostname)) {
    throw new Error(`Endpoint no local rechazado: ${LOCAL_ENDPOINT}`);
  }
  return new DynamoDBClient({
    endpoint: LOCAL_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

export type LocalTable = { input: CreateTableCommandInput; ttlAttribute?: string };

// Deriva las definiciones de tabla de template.yaml para que el entorno local no diverja.
export function localTableDefinitions(stage = LOCAL_STAGE): LocalTable[] {
  return resourcesOfType(loadTemplate(), 'AWS::DynamoDB::Table').map(([, table]) => {
    const p = table.Properties!;
    return {
      input: {
        TableName: subStage(p.TableName, stage) as string,
        BillingMode: p.BillingMode,
        AttributeDefinitions: p.AttributeDefinitions,
        KeySchema: p.KeySchema,
        GlobalSecondaryIndexes: p.GlobalSecondaryIndexes,
      },
      ttlAttribute: p.TimeToLiveSpecification?.AttributeName,
    };
  });
}

export async function waitForLocal(client: DynamoDBClient, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`DynamoDB Local no responde en ${LOCAL_ENDPOINT}`);
}

export async function createLocalTables(
  client: DynamoDBClient,
  stage = LOCAL_STAGE,
): Promise<string[]> {
  const existing = new Set((await client.send(new ListTablesCommand({}))).TableNames ?? []);
  const created: string[] = [];
  for (const { input, ttlAttribute } of localTableDefinitions(stage)) {
    if (existing.has(input.TableName!)) continue;
    await client.send(new CreateTableCommand(input));
    if (ttlAttribute) {
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: input.TableName,
          TimeToLiveSpecification: { AttributeName: ttlAttribute, Enabled: true },
        }),
      );
    }
    created.push(input.TableName!);
  }
  return created;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = localClient();
  await waitForLocal(client);
  const created = await createLocalTables(client);
  process.stdout.write(
    created.length ? `Tablas creadas: ${created.join(', ')}\n` : 'Las tablas ya existían\n',
  );
}
