import {
  type ReviewUrlResponse,
  SECURITY_POLICY,
  UPLOADABLE_STATUSES,
  type UploadUrlResponse,
} from '@eira/shared';
import { HttpError } from '../http/responses.ts';
import type { AuditRepository } from '../repositories/auditRepository.ts';
import { documentKey, type ResultsRepository } from '../repositories/resultsRepository.ts';
import type { DocumentStorage, UploadSpec } from '../storage/DocumentStorage.ts';
import type { ActorMeta } from './patientService.ts';
import { type ResultService, toAdminResultView } from './resultService.ts';

const NOT_UPLOADABLE = 'El resultado no admite un documento nuevo en su estado actual';

/** Carga, confirmación de integridad y lectura para revisión de los PDF (solo administración). */
export class DocumentService {
  private readonly d: {
    results: ResultService;
    repo: ResultsRepository;
    audit: AuditRepository;
    storage: DocumentStorage;
  };
  constructor(deps: DocumentService['d']) {
    this.d = deps;
  }

  async uploadUrl(resultId: string, spec: UploadSpec, meta: ActorMeta): Promise<UploadUrlResponse> {
    const record = await this.d.results.get(resultId);
    if (!UPLOADABLE_STATUSES.includes(record.status)) throw new HttpError(409, NOT_UPLOADABLE);
    const version = record.version + 1;
    const key = documentKey(record.patientId, resultId, version);
    await this.d.audit.append({
      eventType: 'UPLOAD_URL_ISSUED',
      outcome: 'SUCCESS',
      actorType: 'ADMIN',
      actorId: meta.adminId,
      patientId: record.patientId,
      resultId,
      requestId: meta.requestId,
    });
    const ttl = SECURITY_POLICY.uploadUrlTtlSeconds;
    const { url, headers } = await this.d.storage.uploadUrl(key, spec, ttl);
    return { url, method: 'PUT', headers, expiresIn: ttl, version };
  }

  /** Pasa a PENDING_REVIEW solo si el objeto existe con el tamaño y SHA-256 declarados. */
  async submit(resultId: string, spec: UploadSpec, meta: ActorMeta) {
    const record = await this.d.results.get(resultId);
    if (!UPLOADABLE_STATUSES.includes(record.status)) throw new HttpError(409, NOT_UPLOADABLE);
    const version = record.version + 1;
    const key = documentKey(record.patientId, resultId, version);
    const stored = await this.d.storage.head(key);
    if (!stored) throw new HttpError(409, 'No se encontró el documento cargado');
    if (stored.sha256 !== spec.sha256 || stored.sizeBytes !== spec.sizeBytes) {
      throw new HttpError(400, 'El documento cargado no coincide con el declarado (integridad)');
    }
    const updated = await this.d.results.applyEvent(
      record,
      'SUBMIT_DOCUMENT',
      {
        eventType: 'RESULT_SUBMITTED',
        outcome: 'SUCCESS',
        actorType: 'ADMIN',
        actorId: meta.adminId,
        requestId: meta.requestId,
      },
      { set: { s3Key: key, version, sizeBytes: stored.sizeBytes, sha256: stored.sha256 } },
    );
    return toAdminResultView(updated);
  }

  /** URL de 60 s para revisar legibilidad; solo en PENDING_REVIEW y auditada antes de firmar. */
  async reviewUrl(resultId: string, meta: ActorMeta): Promise<ReviewUrlResponse> {
    const record = await this.d.repo.getForReview(resultId);
    if (!record) throw new HttpError(404, 'Resultado no encontrado');
    const base = {
      eventType: 'REVIEW_URL_ISSUED' as const,
      actorType: 'ADMIN' as const,
      actorId: meta.adminId,
      patientId: record.patientId,
      resultId,
      requestId: meta.requestId,
    };
    if (record.status !== 'PENDING_REVIEW' || !record.s3Key) {
      await this.d.audit.append({ ...base, outcome: 'FAILURE', reasonCode: 'NOT_PENDING_REVIEW' });
      throw new HttpError(409, 'Solo se pueden revisar documentos pendientes de revisión');
    }
    await this.d.audit.append({ ...base, outcome: 'SUCCESS' });
    const ttl = SECURITY_POLICY.reviewUrlTtlSeconds;
    return { url: await this.d.storage.readUrl(record.s3Key, ttl), expiresIn: ttl };
  }
}
