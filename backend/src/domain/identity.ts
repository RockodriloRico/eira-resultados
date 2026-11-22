import { hmac } from '../security/crypto.ts';

export const normalizeName = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export const normalizeFolio = (value: string): string => value.trim().toUpperCase();

export type IdentityHashes = { folioHash: string; nameHash: string; birthDateHash: string };

/** HMAC con separación de dominio por campo; nunca se guardan en claro. */
export function identityHashes(
  secret: string,
  input: { fullName: string; birthDate: string; folio: string },
): IdentityHashes {
  return {
    folioHash: hmac(secret, `folio:${normalizeFolio(input.folio)}`),
    nameHash: hmac(secret, `name:${normalizeName(input.fullName)}`),
    birthDateHash: hmac(secret, `birthDate:${input.birthDate}`),
  };
}

export const clientHash = (secret: string, kind: 'ip' | 'ua', value: string | undefined) =>
  value ? hmac(secret, `${kind}:${value}`) : undefined;

export const pinHmac = (secret: string, challengeId: string, pin: string): string =>
  hmac(secret, `pin:${challengeId}:${pin}`);

export const maskPhone = (phone: string): string =>
  `${phone.slice(0, 3)}${'•'.repeat(Math.max(phone.length - 5, 0))}${phone.slice(-2)}`;
