import { loadConfig, type AppConfig } from '../config.ts';
import { AuditRepository } from '../repositories/auditRepository.ts';
import { createDb, type Db } from '../repositories/db.ts';
import { AwsSecretsProvider, type SecretsProvider } from '../security/secrets.ts';
import { AccessService } from '../services/accessService.ts';
import { S3Client } from '@aws-sdk/client-s3';
import { ResultsRepository } from '../repositories/resultsRepository.ts';
import { SessionsRepository } from '../repositories/sessionsRepository.ts';
import { PatientResultsService } from '../services/patientResultsService.ts';
import { SessionService } from '../services/sessionService.ts';
import { type DocumentStorage, S3DocumentStorage } from '../storage/DocumentStorage.ts';
import { AwsSnsSmsProvider, MockSmsProvider, type SmsProvider } from '../sms/SmsProvider.ts';

/** Dependencias por contenedor Lambda, creadas al primer uso. */
export type Container = {
  config: AppConfig;
  db: Db;
  secrets: SecretsProvider;
  sms: SmsProvider;
  audit: AuditRepository;
  storage: DocumentStorage;
  access: AccessService;
  sessions: SessionService;
  patientResults: PatientResultsService;
};

export function buildContainer(
  config: AppConfig,
  overrides: {
    db?: Db;
    secrets?: SecretsProvider;
    sms?: SmsProvider;
    storage?: DocumentStorage;
    clock?: () => Date;
  } = {},
): Container {
  const db = overrides.db ?? createDb();
  const secrets =
    overrides.secrets ??
    new AwsSecretsProvider(
      process.env.IDENTITY_HMAC_SECRET_ARN ?? '',
      process.env.PIN_HMAC_SECRET_ARN ?? '',
    );
  const sms =
    overrides.sms ??
    (config.smsProvider === 'sns' ? new AwsSnsSmsProvider() : new MockSmsProvider());
  const audit = new AuditRepository(db, config.tables.auditLog);
  const clock = overrides.clock ?? (() => new Date());
  const storage =
    overrides.storage ??
    new S3DocumentStorage(new S3Client({}), config.documentsBucket, config.documentsKeyArn);
  const results = new ResultsRepository(db, config.tables.results);
  return {
    config,
    db,
    secrets,
    sms,
    audit,
    storage,
    access: new AccessService({ config, db, audit, secrets, sms, clock }),
    sessions: new SessionService({
      sessions: new SessionsRepository(db, config.tables.accessSessions),
      audit,
      clock,
    }),
    patientResults: new PatientResultsService({ results, audit, storage }),
  };
}

let current: Container | undefined;
export const container = (): Container => (current ??= buildContainer(loadConfig()));
