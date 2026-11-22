import {
  type AdminResultView,
  type ResultEvent,
  type ReviewBody,
  nextResultStatus,
} from '@eira/shared';
import { HttpError } from '../http/responses.ts';
import { randomId } from '../security/crypto.ts';
import type { AuditRepository } from '../repositories/auditRepository.ts';
import { isConditionFailure } from '../repositories/db.ts';
import type { PatientsRepository } from '../repositories/patientsRepository.ts';
import type { ResultRecord, ResultsRepository } from '../repositories/resultsRepository.ts';
import type { ActorMeta, Clock } from './patientService.ts';

export const toAdminResultView = (r: ResultRecord): AdminResultView => ({
  resultId: r.resultId,
  patientId: r.patientId,
  resultType: r.resultType,
  sampleDate: r.sampleDate,
  status: r.status,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  availableAt: r.availableAt,
  sizeBytes: r.sizeBytes,
  sha256: r.sha256,
  reviewNote: r.reviewNote,
});

const CONFLICT = 'El resultado cambió de estado; recarga e intenta de nuevo';

export class ResultService {
  private readonly deps: {
    results: ResultsRepository;
    patients: PatientsRepository;
    audit: AuditRepository;
    clock: Clock;
  };
  constructor(deps: ResultService['deps']) {
    this.deps = deps;
  }

  /** Asociación segura: el expediente debe existir y estar activo. */
  async create(
    input: { patientId: string; resultType: string; sampleDate: string },
    meta: ActorMeta,
    options: { resultId?: string } = {},
  ): Promise<AdminResultView> {
    const { results, patients, audit, clock } = this.deps;
    const patient = await patients.getAttributes(input.patientId, ['patientId', 'status'] as const);
    if (!patient || patient.status !== 'ACTIVE')
      throw new HttpError(404, 'Expediente no encontrado');
    const now = clock().toISOString();
    const record: ResultRecord = {
      resultId: options.resultId ?? `res_${randomId()}`,
      patientId: input.patientId,
      resultType: input.resultType,
      sampleDate: input.sampleDate,
      status: 'CREATED',
      version: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: meta.adminId,
    };
    await results.create(record);
    await audit.append({
      eventType: 'RESULT_CREATED',
      outcome: 'SUCCESS',
      actorType: 'ADMIN',
      actorId: meta.adminId,
      patientId: record.patientId,
      resultId: record.resultId,
      requestId: meta.requestId,
    });
    return toAdminResultView(record);
  }

  async get(resultId: string): Promise<ResultRecord> {
    const record = await this.deps.results.get(resultId);
    if (!record) throw new HttpError(404, 'Resultado no encontrado');
    return record;
  }

  async listForAdmin(patientId: string): Promise<AdminResultView[]> {
    const items = await this.deps.results.listByPatient(patientId);
    const full = await Promise.all(items.map((i) => this.deps.results.get(i.resultId)));
    return full.filter((r): r is ResultRecord => r !== undefined).map(toAdminResultView);
  }

  /** Aplica un evento de la máquina de estados con condición sobre el estado y la versión. */
  async applyEvent(
    record: ResultRecord,
    event: ResultEvent,
    changes: { set?: Record<string, unknown>; remove?: string[] } = {},
  ): Promise<ResultRecord> {
    const to = nextResultStatus(record.status, event);
    if (!to) throw new HttpError(409, 'Transición de estado no permitida');
    const now = this.deps.clock();
    try {
      await this.deps.results.transition({
        resultId: record.resultId,
        from: record.status,
        to,
        expectedVersion: record.version,
        ...changes,
        now,
      });
    } catch (error) {
      if (isConditionFailure(error)) throw new HttpError(409, CONFLICT);
      throw error;
    }
    return {
      ...record,
      ...(changes.set as Partial<ResultRecord>),
      status: to,
      updatedAt: now.toISOString(),
    };
  }

  /** Revisión administrativa: correspondencia, integridad y legibilidad. Sin validación clínica. */
  async review(resultId: string, body: ReviewBody, meta: ActorMeta): Promise<AdminResultView> {
    const record = await this.get(resultId);
    const allChecked =
      body.checks.correspondence && body.checks.integrity && body.checks.legibility;
    if (body.decision === 'APPROVE' && !allChecked) {
      throw new HttpError(400, 'Para aprobar deben confirmarse las tres revisiones');
    }
    if (body.decision === 'REQUEST_CORRECTION' && !body.note) {
      throw new HttpError(400, 'Indica el motivo de la corrección');
    }
    const now = this.deps.clock().toISOString();
    const updated =
      body.decision === 'APPROVE'
        ? await this.applyEvent(record, 'APPROVE', {
            set: { availableAt: now, reviewedBy: meta.adminId },
            remove: ['reviewNote'],
          })
        : await this.applyEvent(record, 'REQUEST_CORRECTION', {
            set: { reviewedBy: meta.adminId, reviewNote: body.note },
          });
    await this.deps.audit.append({
      eventType: body.decision === 'APPROVE' ? 'RESULT_APPROVED' : 'RESULT_CORRECTION_REQUESTED',
      outcome: 'SUCCESS',
      actorType: 'ADMIN',
      actorId: meta.adminId,
      patientId: record.patientId,
      resultId,
      requestId: meta.requestId,
    });
    return toAdminResultView(updated);
  }
}
