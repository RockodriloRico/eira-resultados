import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  createLocalTables,
  localClient,
  localTableDefinitions,
  waitForLocal,
} from '../../../infrastructure/scripts/local-tables.ts';
import { loadConfig } from '../../src/config.ts';
import { createDb } from '../../src/repositories/db.ts';
import { AuditRepository } from '../../src/repositories/auditRepository.ts';
import { PatientsRepository } from '../../src/repositories/patientsRepository.ts';
import { ResultsRepository } from '../../src/repositories/resultsRepository.ts';
import { ChallengesRepository } from '../../src/repositories/challengesRepository.ts';
import { SessionsRepository } from '../../src/repositories/sessionsRepository.ts';
import { StaticSecretsProvider } from '../../src/security/secrets.ts';

/** Entorno aislado por prueba en DynamoDB Local (requiere `npm run dynamodb:up`). */
export async function createTestEnv(prefix: string) {
  const stage = `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const raw = localClient();
  await waitForLocal(raw);
  await createLocalTables(raw, stage);
  const config = { ...loadConfig({ STAGE: 'local' }), stage: 'local' as const };
  const t = (name: string) => `eira-${stage}-${name}`;
  config.tables = {
    patients: t('Patients'),
    pinChallenges: t('PinChallenges'),
    accessSessions: t('AccessSessions'),
    results: t('Results'),
    auditLog: t('AuditLog'),
  };
  const db = createDb({
    endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  return {
    config,
    db,
    secrets: new StaticSecretsProvider({ identity: 'i'.repeat(32), pin: 'p'.repeat(32) }),
    repos: {
      patients: new PatientsRepository(db, config.tables.patients),
      results: new ResultsRepository(db, config.tables.results),
      audit: new AuditRepository(db, config.tables.auditLog),
      challenges: new ChallengesRepository(db, config.tables.pinChallenges),
      sessions: new SessionsRepository(db, config.tables.accessSessions),
    },
    async destroy() {
      for (const { input } of localTableDefinitions(stage)) {
        await raw
          .send(new DeleteTableCommand({ TableName: input.TableName }))
          .catch(() => undefined);
      }
    },
  };
}
export type TestEnv = Awaited<ReturnType<typeof createTestEnv>>;
