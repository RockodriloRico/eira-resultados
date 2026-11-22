import { z } from 'zod';
import type { RESULT_STATUSES } from './resultStatus.ts';
import { SECURITY_POLICY } from './securityPolicy.ts';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  });

export const fullNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[\p{L}][\p{L} .'-]*$/u);
export const folioSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{4,32}$/);
export const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const challengeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const pinSchema = z.string().regex(/^\d{6}$/);
const ENTITY_ID = { pat: /^pat_[A-Za-z0-9_-]{22}$/, res: /^res_[A-Za-z0-9_-]{22}$/ } as const;
export const entityIdSchema = (prefix: keyof typeof ENTITY_ID) =>
  // eslint-disable-next-line security/detect-object-injection -- clave tipada y cerrada
  z.string().regex(ENTITY_ID[prefix]);

// ---------------------------------------------------------------- Paciente
export const accessRequestBody = z.strictObject({
  fullName: fullNameSchema,
  birthDate: isoDate,
  folio: folioSchema,
});
export type AccessRequestBody = z.infer<typeof accessRequestBody>;

export const resendBody = z.strictObject({ challengeId: challengeIdSchema });
export const verifyBody = z.strictObject({ challengeId: challengeIdSchema, pin: pinSchema });

export type ChallengeResponse = {
  challengeId: string;
  expiresIn: number;
  resendAfter: number;
  /** Solo en Stage=demo con MockSmsProvider; presente en respuestas reales y señuelo. */
  demoPin?: string | undefined;
};
export type VerifyResponse = { token: string; expiresIn: number };
export type PatientResultSummary = {
  resultId: string;
  resultType: string;
  sampleDate: string;
  availableAt: string;
};
export type DownloadUrlResponse = { url: string; expiresIn: number };
export type ErrorResponse = { message: string };

// ---------------------------------------------------------------- Administración
export const createPatientBody = z.strictObject({
  fullName: fullNameSchema,
  birthDate: isoDate,
  folio: folioSchema,
  phone: phoneSchema,
});
export const findPatientQuery = z.strictObject({ folio: folioSchema });

export type AdminPatientView = {
  patientId: string;
  status: 'ACTIVE' | 'DISABLED';
  dataClassification: 'SYNTHETIC' | 'CONFIDENTIAL';
  phoneMasked: string;
  createdAt: string;
};

export const RESULT_TYPES = ['PAPANICOLAOU'] as const;
export const createResultBody = z.strictObject({
  patientId: entityIdSchema('pat'),
  resultType: z.enum(RESULT_TYPES),
  sampleDate: isoDate,
});

export const uploadUrlBody = z.strictObject({
  contentType: z.literal('application/pdf'),
  sizeBytes: z.number().int().min(1).max(SECURITY_POLICY.maxDocumentBytes),
  /** SHA-256 del archivo en base64 (formato de x-amz-checksum-sha256). */
  sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
/** Confirmación de carga: S3 ya verificó el SHA-256 al recibir el archivo; aquí se compara. */
export const submitDocumentBody = uploadUrlBody.omit({ contentType: true });
export type ReviewUrlResponse = { url: string; expiresIn: number };
export type UploadUrlResponse = {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresIn: number;
  version: number;
};

export const reviewBody = z.strictObject({
  decision: z.enum(['APPROVE', 'REQUEST_CORRECTION']),
  checks: z.strictObject({
    correspondence: z.boolean(),
    integrity: z.boolean(),
    legibility: z.boolean(),
  }),
  note: z.string().trim().max(500).optional(),
});
export type ReviewBody = z.infer<typeof reviewBody>;

export type AdminResultView = {
  resultId: string;
  patientId: string;
  resultType: string;
  sampleDate: string;
  status: (typeof RESULT_STATUSES)[number];
  version: number;
  createdAt: string;
  updatedAt: string;
  availableAt?: string | undefined;
  sizeBytes?: number | undefined;
  sha256?: string | undefined;
  reviewNote?: string | undefined;
};

export const auditQuery = z
  .strictObject({
    patientId: entityIdSchema('pat').optional(),
    eventType: z
      .string()
      .regex(/^[A-Z_]{3,40}$/)
      .optional(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    cursor: z.string().max(1024).optional(),
  })
  .refine((q) => (q.patientId === undefined) !== (q.eventType === undefined), {
    message: 'Exactamente un filtro: patientId o eventType',
  })
  .refine((q) => {
    const span = Date.parse(q.to) - Date.parse(q.from);
    return span >= 0 && span <= 31 * 24 * 3600 * 1000;
  });

export type AuditEventView = {
  eventId: string;
  eventType: string;
  outcome: 'SUCCESS' | 'FAILURE';
  reasonCode?: string | undefined;
  occurredAt: string;
  actorType: 'PATIENT' | 'ADMIN' | 'SYSTEM';
  actorId?: string | undefined;
  patientId?: string | undefined;
  resultId?: string | undefined;
};
