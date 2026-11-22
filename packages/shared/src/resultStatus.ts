export const RESULT_STATUSES = [
  'CREATED',
  'PENDING_REVIEW',
  'APPROVED',
  'CORRECTION_REQUESTED',
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const RESULT_EVENTS = ['SUBMIT_DOCUMENT', 'APPROVE', 'REQUEST_CORRECTION'] as const;
export type ResultEvent = (typeof RESULT_EVENTS)[number];

const TRANSITIONS: Readonly<Record<ResultEvent, Partial<Record<ResultStatus, ResultStatus>>>> = {
  SUBMIT_DOCUMENT: { CREATED: 'PENDING_REVIEW', CORRECTION_REQUESTED: 'PENDING_REVIEW' },
  APPROVE: { PENDING_REVIEW: 'APPROVED' },
  REQUEST_CORRECTION: { PENDING_REVIEW: 'CORRECTION_REQUESTED' },
};

/** Estado destino, o `undefined` si la transición no está permitida. */
export function nextResultStatus(from: ResultStatus, event: ResultEvent): ResultStatus | undefined {
  // eslint-disable-next-line security/detect-object-injection -- claves tipadas y cerradas
  return TRANSITIONS[event][from];
}

/** Estados desde los que se acepta un documento nuevo. */
export const UPLOADABLE_STATUSES: readonly ResultStatus[] = ['CREATED', 'CORRECTION_REQUESTED'];

/** Solo los resultados aprobados son visibles para la paciente. */
export const PATIENT_VISIBLE_STATUS: ResultStatus = 'APPROVED';
