import { describe, expect, it } from 'vitest';
import {
  identityHashes,
  maskPhone,
  normalizeFolio,
  normalizeName,
  pinHmac,
} from '../../src/domain/identity.ts';
import { randomId, randomPin, randomToken, safeEqual } from '../../src/security/crypto.ts';
import { redact } from '../../src/observability/logger.ts';
import { pinMessage } from '../../src/sms/SmsProvider.ts';
import { loadConfig } from '../../src/config.ts';

const SECRET = 'x'.repeat(32);

describe('normalización de identidad', () => {
  it('ignora mayúsculas, acentos y espacios repetidos', () => {
    expect(normalizeName('  maría   josé  NÚÑEZ ')).toBe('MARIA JOSE NUNEZ');
    expect(normalizeFolio(' sint-0001 ')).toBe('SINT-0001');
  });

  it('HMAC estable, con separación por campo y dependiente del secreto', () => {
    const input = { fullName: 'María Núñez', birthDate: '1990-01-01', folio: 'sint-1' };
    const a = identityHashes(SECRET, input);
    expect(identityHashes(SECRET, { ...input, fullName: 'MARIA  NUNEZ', folio: 'SINT-1' })).toEqual(
      a,
    );
    expect(identityHashes('y'.repeat(32), input)).not.toEqual(a);
    expect(new Set(Object.values(a)).size).toBe(3);
    expect(JSON.stringify(a)).not.toContain('1990');
  });

  it('el HMAC del PIN depende del reto', () => {
    expect(pinHmac(SECRET, 'a', '123456')).not.toBe(pinHmac(SECRET, 'b', '123456'));
  });

  it('enmascara el teléfono', () => {
    expect(maskPhone('+525500000001')).toBe('+52••••••••01');
  });
});

describe('aleatoriedad y comparación', () => {
  it('PIN de seis dígitos con ceros a la izquierda', () => {
    for (let i = 0; i < 500; i += 1) expect(randomPin()).toMatch(/^\d{6}$/);
  });

  it('identificadores y tokens de longitud fija', () => {
    expect(randomId()).toHaveLength(22);
    expect(randomToken()).toHaveLength(43);
  });

  it('safeEqual compara sin fallar con longitudes distintas', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('SMS y logs', () => {
  it('el SMS contiene solo el código, sin datos clínicos', () => {
    const msg = pinMessage('012345');
    expect(msg).toContain('012345');
    expect(msg).not.toMatch(/resultado|papanicolaou|positivo|negativo|diagn/i);
  });

  it('el logger redacta datos sensibles en cualquier nivel', () => {
    const out = JSON.stringify(
      redact({ pin: '1', nested: { token: 't', phone: 'p', ok: 1 }, list: [{ demoPin: 'x' }] }),
    );
    expect(out).not.toMatch(/"1"|"t"|"p"|"x"/);
    expect(out).toContain('"ok":1');
  });
});

describe('configuración', () => {
  it('demoPin solo en demo con proveedor mock', () => {
    expect(
      loadConfig({ STAGE: 'demo', SMS_PROVIDER: 'mock', DEMO_PIN_ENABLED: 'true' }).demoPinEnabled,
    ).toBe(true);
    expect(
      loadConfig({ STAGE: 'dev', SMS_PROVIDER: 'mock', DEMO_PIN_ENABLED: 'true' }).demoPinEnabled,
    ).toBe(false);
    expect(
      loadConfig({ STAGE: 'demo', SMS_PROVIDER: 'sns', DEMO_PIN_ENABLED: 'true' }).demoPinEnabled,
    ).toBe(false);
  });

  it('prod rechaza el proveedor mock', () => {
    expect(() => loadConfig({ STAGE: 'prod', SMS_PROVIDER: 'mock' })).toThrow();
    // Funciones sin SMS_PROVIDER (p. ej. verify) arrancan en prod y nunca usan mock.
    expect(loadConfig({ STAGE: 'prod' }).smsProvider).toBe('sns');
    expect(loadConfig({ STAGE: 'prod' }).demoPinEnabled).toBe(false);
  });
});
