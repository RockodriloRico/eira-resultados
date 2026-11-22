export type Stage = 'local' | 'dev' | 'demo' | 'prod';

export type AppConfig = {
  stage: Stage;
  smsProvider: 'mock' | 'sns';
  demoPinEnabled: boolean;
  corsAllowedOrigin: string | undefined;
  minResponseMs: number;
  tables: {
    patients: string;
    pinChallenges: string;
    accessSessions: string;
    results: string;
    auditLog: string;
  };
  documentsBucket: string;
  documentsKeyArn: string | undefined;
};

const STAGES: readonly Stage[] = ['local', 'dev', 'demo', 'prod'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const stage = (env.STAGE ?? 'local') as Stage;
  if (!STAGES.includes(stage)) throw new Error(`STAGE no válido: ${stage}`);
  // Sin SMS_PROVIDER (funciones que no envían SMS), prod nunca cae en mock.
  const smsProvider =
    env.SMS_PROVIDER === 'mock' || (env.SMS_PROVIDER === undefined && stage !== 'prod')
      ? 'mock'
      : 'sns';
  if (stage === 'prod' && smsProvider === 'mock') {
    throw new Error('Stage=prod no admite SmsProvider=mock');
  }
  // eslint-disable-next-line security/detect-object-injection -- nombres fijos de variables
  const table = (name: string, suffix: string) => env[name] ?? `eira-${stage}-${suffix}`;
  return {
    stage,
    smsProvider,
    demoPinEnabled: env.DEMO_PIN_ENABLED === 'true' && stage === 'demo' && smsProvider === 'mock',
    corsAllowedOrigin: env.CORS_ALLOWED_ORIGIN,
    minResponseMs: Number(env.MIN_RESPONSE_MS ?? 1000),
    tables: {
      patients: table('PATIENTS_TABLE', 'Patients'),
      pinChallenges: table('PIN_CHALLENGES_TABLE', 'PinChallenges'),
      accessSessions: table('ACCESS_SESSIONS_TABLE', 'AccessSessions'),
      results: table('RESULTS_TABLE', 'Results'),
      auditLog: table('AUDIT_LOG_TABLE', 'AuditLog'),
    },
    documentsBucket: env.DOCUMENTS_BUCKET ?? `eira-${stage}-documents`,
    documentsKeyArn: env.DOCUMENTS_KEY_ARN,
  };
}
