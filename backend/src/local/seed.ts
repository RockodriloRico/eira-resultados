import type { PatientService } from '../services/patientService.ts';
import type { ResultService } from '../services/resultService.ts';
import { SYNTHETIC_PATIENTS, SYNTHETIC_RESULTS, syntheticId } from './syntheticData.ts';

export const SEED_ADMIN = { adminId: 'local-seed', requestId: 'seed' };

/**
 * Carga expedientes y resultados sintéticos. Los aprobados reciben su documento en la entrega 3
 * (almacenamiento local); aquí solo se crean metadatos.
 */
export async function seedSynthetic(services: {
  patients: PatientService;
  results: ResultService;
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
  }
  return { patientIds, resultIds };
}
