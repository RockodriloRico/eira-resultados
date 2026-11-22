import type { PatientService } from '../services/patientService.ts';
import { createHash } from 'node:crypto';
import { documentKey } from '../repositories/resultsRepository.ts';
import type { ResultService } from '../services/resultService.ts';
import type { DocumentStorage } from '../storage/DocumentStorage.ts';
import { syntheticPdf } from './syntheticPdf.ts';
import { SYNTHETIC_PATIENTS, SYNTHETIC_RESULTS, syntheticId } from './syntheticData.ts';

export const SEED_ADMIN = { adminId: 'local-seed', requestId: 'seed' };

/**
 * Carga expedientes y resultados sintéticos. Con `storage`, los marcados como aprobados reciben un
 * PDF sintético y pasan por revisión (tres comprobaciones administrativas) hasta `APPROVED`.
 */
export async function seedSynthetic(services: {
  patients: PatientService;
  results: ResultService;
  storage?: DocumentStorage;
}) {
  const patientIds = new Map<string, string>();
  for (const p of SYNTHETIC_PATIENTS) {
    const { patientId } = await services.patients.create(p, SEED_ADMIN);
    patientIds.set(p.folio, patientId);
  }
  const resultIds: string[] = [];
  for (const [i, r] of SYNTHETIC_RESULTS.entries()) {
    const resultId = syntheticId('res', `${r.folio}:${i}`);
    await services.results.create(
      { patientId: patientIds.get(r.folio)!, resultType: 'PAPANICOLAOU', sampleDate: r.sampleDate },
      SEED_ADMIN,
      { resultId },
    );
    resultIds.push(resultId);
    if (services.storage && r.approved) {
      const record = await services.results.get(resultId);
      const version = record.version + 1;
      const key = documentKey(record.patientId, resultId, version);
      const pdf = syntheticPdf([`Folio: ${r.folio}`, `Fecha de muestra: ${r.sampleDate}`]);
      await services.storage.put(key, pdf);
      await services.results.applyEvent(
        record,
        'SUBMIT_DOCUMENT',
        {
          eventType: 'RESULT_SUBMITTED',
          outcome: 'SUCCESS',
          actorType: 'ADMIN',
          actorId: SEED_ADMIN.adminId,
        },
        {
          set: {
            s3Key: key,
            version,
            sizeBytes: pdf.byteLength,
            sha256: createHash('sha256').update(pdf).digest('base64'),
          },
        },
      );
      const checks = { correspondence: true, integrity: true, legibility: true };
      await services.results.review(resultId, { decision: 'APPROVE', checks }, SEED_ADMIN);
    }
  }
  return { patientIds, resultIds };
}
