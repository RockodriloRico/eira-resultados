import { loadConfig, type AppConfig } from '../config.ts';
import { AuditRepository } from '../repositories/auditRepository.ts';
import { createDb, type Db } from '../repositories/db.ts';
import { AwsSecretsProvider, type SecretsProvider } from '../security/secrets.ts';
import { AccessService } from '../services/accessService.ts';
import { AwsSnsSmsProvider, MockSmsProvider, type SmsProvider } from '../sms/SmsProvider.ts';

/** Dependencias por contenedor Lambda, creadas al primer uso. */
export type Container = {
  config: AppConfig;
  db: Db;
  secrets: SecretsProvider;
  sms: SmsProvider;
  audit: AuditRepository;
  access: AccessService;
};

export function buildContainer(
  config: AppConfig,
  overrides: { db?: Db; secrets?: SecretsProvider; sms?: SmsProvider; clock?: () => Date } = {},
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
  return {
    config,
    db,
    secrets,
    sms,
    audit,
    access: new AccessService({ config, db, audit, secrets, sms, clock }),
  };
}

let current: Container | undefined;
export const container = (): Container => (current ??= buildContainer(loadConfig()));
