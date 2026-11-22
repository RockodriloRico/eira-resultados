import {
  type DownloadUrlResponse,
  type PatientResultSummary,
  PATIENT_VISIBLE_STATUS,
  SECURITY_POLICY,
} from '@eira/shared';
import { GENERIC, HttpError } from '../http/responses.ts';
import type { AuditRepository } from '../repositories/auditRepository.ts';
import type { ResultsRepository } from '../repositories/resultsRepository.ts';
import type { DocumentStorage } from '../storage/DocumentStorage.ts';
import type { ClientMeta } from './accessService.ts';

/** Vista de la paciente: solo sus resultados aprobados; el patientId viene del authorizer. */
export class PatientResultsService {
  private readonly d: {
    results: ResultsRepository;
    audit: AuditRepository;
    storage?: DocumentStorage;
  };
  constructor(deps: PatientResultsService['d']) {
    this.d = deps;
  }

  async list(patientId: string, meta: ClientMeta): Promise<PatientResultSummary[]> {
    const items = await this.d.results.listByPatient(patientId, PATIENT_VISIBLE_STATUS);
    await this.d.audit.tryAppend({
      eventType: 'RESULTS_LISTED',
      outcome: 'SUCCESS',
      actorType: 'PATIENT',
      patientId,
      requestId: meta.requestId,
    });
    return items
      .filter((i) => i.status === PATIENT_VISIBLE_STATUS && i.availableAt)
      .map((i) => ({
        resultId: i.resultId,
        resultType: i.resultType,
        sampleDate: i.sampleDate,
        availableAt: i.availableAt!,
      }));
  }

  /** La auditoría se escribe antes de firmar: si falla, no hay URL (fail-closed). */
  async downloadUrl(
    patientId: string,
    resultId: string,
    meta: ClientMeta,
  ): Promise<DownloadUrlResponse> {
    if (!this.d.storage) throw new Error('Almacenamiento de documentos no configurado');
    const result = await this.d.results.get(resultId);
    if (
      !result ||
      result.patientId !== patientId ||
      result.status !== PATIENT_VISIBLE_STATUS ||
      !result.s3Key
    ) {
      // Mismo 404 para inexistente, ajeno o no aprobado: no revela resultados de otras pacientes.
      await this.d.audit.tryAppend({
        eventType: 'DOWNLOAD_DENIED',
        outcome: 'FAILURE',
        actorType: 'PATIENT',
        patientId,
        resultId,
        reasonCode: !result
          ? 'NOT_FOUND'
          : result.patientId !== patientId
            ? 'NOT_OWNER'
            : 'NOT_AVAILABLE',
        requestId: meta.requestId,
      });
      throw new HttpError(404, GENERIC.notFound);
    }
    await this.d.audit.append({
      eventType: 'DOWNLOAD_URL_ISSUED',
      outcome: 'SUCCESS',
      actorType: 'PATIENT',
      patientId,
      resultId,
      requestId: meta.requestId,
    });
    const ttl = SECURITY_POLICY.downloadUrlTtlSeconds;
    return { url: await this.d.storage.readUrl(result.s3Key, ttl), expiresIn: ttl };
  }
}
