const REDACTED_KEYS = new Set([
  'pin',
  'demopin',
  'token',
  'authorization',
  'phone',
  'fullname',
  'birthdate',
  'folio',
  'body',
  'secret',
  'url',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1),
    ]),
  );
}

export const METRIC_NAMESPACE = 'EiraResultados';

/** Métricas de aplicación; las alarmas de la plantilla usan estos mismos nombres. */
export const METRIC_NAMES = [
  'AuditWriteFailed',
  'SmsSendFailed',
  'NonSyntheticRecordInDemo',
  'ResponseFloorExceeded',
  'PinVerifyFailed',
  'PinChallengeLocked',
  'DownloadDenied',
  'AdminForbidden',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

type Level = 'INFO' | 'WARN' | 'ERROR';
function write(level: Level, message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, message, ...(redact(fields) as object) });
  (level === 'INFO' ? process.stdout : process.stderr).write(`${line}\n`);
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => write('INFO', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('WARN', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('ERROR', message, fields),
  /**
   * Métrica en CloudWatch Embedded Metric Format (namespace `EiraResultados`, dimensión `Stage`).
   * Solo nombres de una lista cerrada y conteos: nunca identificadores ni datos personales.
   */
  metric: (name: MetricName, value = 1) =>
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [['Stage']],
              Metrics: [{ Name: name, Unit: 'Count' }],
            },
          ],
        },
        Stage: process.env.STAGE ?? 'local',
        [name]: value,
      })}\n`,
    ),
};
