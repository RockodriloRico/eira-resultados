export const SECURITY_POLICY = Object.freeze({
  pinLength: 6,
  pinTtlSeconds: 5 * 60,
  pinMaxAttempts: 5,
  pinResendCooldownSeconds: 60,
  patientSessionTtlSeconds: 15 * 60,
  downloadUrlTtlSeconds: 60,
});

export type SecurityPolicy = typeof SECURITY_POLICY;
