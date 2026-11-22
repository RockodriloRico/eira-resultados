import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { SECURITY_POLICY } from '@eira/shared';

/** 128 bits en base64url: siempre 22 caracteres. */
export const randomId = (): string => randomBytes(16).toString('base64url');
export const randomToken = (): string => randomBytes(32).toString('base64url');
export const randomPin = (): string =>
  randomInt(0, 10 ** SECURITY_POLICY.pinLength)
    .toString()
    .padStart(SECURITY_POLICY.pinLength, '0');

export const hmac = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

/** Comparación en tiempo constante; longitudes distintas no cortocircuitan el trabajo. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const same = left.length === right.length;
  return timingSafeEqual(left, same ? right : left) && same;
}
