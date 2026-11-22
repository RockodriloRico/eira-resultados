import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export type Db = DynamoDBDocumentClient;

export function createDb(config: DynamoDBClientConfig = {}): Db {
  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export const isConditionFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'ConditionalCheckFailedException' ||
    (error.name === 'TransactionCanceledException' &&
      error.message.includes('ConditionalCheckFailed')));

export const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
