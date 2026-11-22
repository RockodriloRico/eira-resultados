export const SECURITY_POLICY = Object.freeze({
  pinLength: 6,
  pinTtlSeconds: 5 * 60,
  pinMaxAttempts: 5,
  pinResendCooldownSeconds: 60,
  pinMaxResends: 3,
  smsMaxPerWindow: 5,
  smsWindowSeconds: 60 * 60,
  patientSessionTtlSeconds: 15 * 60,
  downloadUrlTtlSeconds: 60,
  reviewUrlTtlSeconds: 60,
  uploadUrlTtlSeconds: 5 * 60,
  maxDocumentBytes: 10 * 1024 * 1024,
});

export type SecurityPolicy = typeof SECURITY_POLICY;
