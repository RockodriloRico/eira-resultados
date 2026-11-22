import { describe, expect, it } from 'vitest';
import {
  accessRequestBody,
  auditQuery,
  reviewBody,
  uploadUrlBody,
  verifyBody,
} from '../src/index.ts';

describe('contratos de la API', () => {
  it('valida la identificación de la paciente y rechaza campos extra', () => {
    const ok = { fullName: 'Ana Sintética López', birthDate: '1990-02-28', folio: 'EIRA-0001' };
    expect(accessRequestBody.safeParse(ok).success).toBe(true);
    expect(accessRequestBody.safeParse({ ...ok, birthDate: '1990-02-30' }).success).toBe(false);
    expect(accessRequestBody.safeParse({ ...ok, patientId: 'x' }).success).toBe(false);
  });

  it('exige PIN de seis dígitos y challengeId de longitud fija', () => {
    const challengeId = 'a'.repeat(22);
    expect(verifyBody.safeParse({ challengeId, pin: '012345' }).success).toBe(true);
    expect(verifyBody.safeParse({ challengeId, pin: '12345' }).success).toBe(false);
    expect(verifyBody.safeParse({ challengeId: 'short', pin: '012345' }).success).toBe(false);
  });

  it('solo acepta PDF de hasta 10 MB con SHA-256', () => {
    const base = { contentType: 'application/pdf', sizeBytes: 1000, sha256: `${'A'.repeat(43)}=` };
    expect(uploadUrlBody.safeParse(base).success).toBe(true);
    expect(uploadUrlBody.safeParse({ ...base, contentType: 'text/html' }).success).toBe(false);
    expect(uploadUrlBody.safeParse({ ...base, sizeBytes: 11 * 1024 * 1024 }).success).toBe(false);
  });

  it('la revisión exige las tres comprobaciones', () => {
    expect(
      reviewBody.safeParse({ decision: 'APPROVE', checks: { correspondence: true } }).success,
    ).toBe(false);
  });

  it('la auditoría exige exactamente un filtro y un rango de hasta 31 días', () => {
    const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-20T00:00:00Z' };
    expect(auditQuery.safeParse({ ...range, eventType: 'PIN_REQUESTED' }).success).toBe(true);
    expect(auditQuery.safeParse(range).success).toBe(false);
    expect(
      auditQuery.safeParse({ ...range, eventType: 'X_Y_Z', patientId: `pat_${'a'.repeat(22)}` })
        .success,
    ).toBe(false);
    expect(
      auditQuery.safeParse({
        from: '2026-01-01T00:00:00Z',
        to: '2026-03-01T00:00:00Z',
        eventType: 'PIN_REQUESTED',
      }).success,
    ).toBe(false);
  });
});
