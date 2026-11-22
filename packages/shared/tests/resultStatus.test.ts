import { describe, expect, it } from 'vitest';
import { RESULT_EVENTS, RESULT_STATUSES, nextResultStatus } from '../src/index.ts';

describe('máquina de estados de resultados', () => {
  it('permite solo las transiciones aprobadas', () => {
    const allowed: string[] = [];
    for (const from of RESULT_STATUSES) {
      for (const event of RESULT_EVENTS) {
        const to = nextResultStatus(from, event);
        if (to) allowed.push(`${from} -${event}-> ${to}`);
      }
    }
    expect(allowed.sort()).toEqual([
      'CORRECTION_REQUESTED -SUBMIT_DOCUMENT-> PENDING_REVIEW',
      'CREATED -SUBMIT_DOCUMENT-> PENDING_REVIEW',
      'PENDING_REVIEW -APPROVE-> APPROVED',
      'PENDING_REVIEW -REQUEST_CORRECTION-> CORRECTION_REQUESTED',
    ]);
  });

  it('un resultado aprobado no admite más cambios', () => {
    for (const event of RESULT_EVENTS) expect(nextResultStatus('APPROVED', event)).toBeUndefined();
  });
});
