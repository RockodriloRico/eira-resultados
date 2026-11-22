import { describe, expect, it } from 'vitest';
import { SECURITY_POLICY } from '../src/index.ts';

describe('SECURITY_POLICY', () => {
  it('refleja los requisitos aprobados del flujo de acceso', () => {
    expect(SECURITY_POLICY).toEqual({
      pinLength: 6,
      pinTtlSeconds: 300,
      pinMaxAttempts: 5,
      pinResendCooldownSeconds: 60,
      pinMaxResends: 3,
      smsMaxPerWindow: 5,
      smsWindowSeconds: 3600,
      patientSessionTtlSeconds: 900,
      downloadUrlTtlSeconds: 60,
      reviewUrlTtlSeconds: 60,
      uploadUrlTtlSeconds: 300,
      maxDocumentBytes: 10485760,
    });
  });

  it('no puede modificarse en tiempo de ejecución', () => {
    expect(Object.isFrozen(SECURITY_POLICY)).toBe(true);
  });
});
