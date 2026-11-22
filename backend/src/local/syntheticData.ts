import { hmac } from '../security/crypto.ts';

/**
 * Datos sintéticos reproducibles para desarrollo y demo. No corresponden a personas reales:
 * nombres inventados, folios con prefijo SINT y teléfonos en el rango ficticio +52 55 0000 00xx.
 */
export const SYNTHETIC_PATIENTS = [
  {
    fullName: 'Ana Prueba Sintética',
    birthDate: '1985-03-14',
    folio: 'SINT-0001',
    phone: '+525500000001',
  },
  {
    fullName: 'Beatriz Ejemplo Ficticia',
    birthDate: '1990-11-02',
    folio: 'SINT-0002',
    phone: '+525500000002',
  },
  {
    fullName: 'Carmen Demo Inventada',
    birthDate: '1978-07-25',
    folio: 'SINT-0003',
    phone: '+525500000003',
  },
] as const;

export const SYNTHETIC_RESULTS = [
  { folio: 'SINT-0001', sampleDate: '2026-10-01', approved: true },
  { folio: 'SINT-0001', sampleDate: '2026-11-03', approved: false },
  { folio: 'SINT-0002', sampleDate: '2026-10-20', approved: true },
] as const;

const SEED = 'eira-synthetic-seed-v1';
/** Identificadores deterministas con el mismo formato que los aleatorios (prefijo + 22 caracteres). */
export const syntheticId = (prefix: 'pat' | 'res', key: string) =>
  `${prefix}_${hmac(SEED, `${prefix}:${key}`).slice(0, 22)}`;
