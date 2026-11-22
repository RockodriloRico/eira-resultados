import type { AuditEventView } from '@eira/shared';
import type { AuditRepository } from '../repositories/auditRepository.ts';
import type { ActorMeta } from './patientService.ts';

/** Consulta administrativa de la auditoría; la propia consulta queda registrada. */
export class AuditQueryService {
  private readonly audit: AuditRepository;
  constructor(audit: AuditRepository) {
    this.audit = audit;
  }

  async query(
    params: {
      patientId?: string | undefined;
      eventType?: string | undefined;
      from: string;
      to: string;
      cursor?: string | undefined;
    },
    meta: ActorMeta,
  ): Promise<{ items: AuditEventView[]; cursor?: string | undefined }> {
    await this.audit.append({
      eventType: 'AUDIT_QUERIED',
      outcome: 'SUCCESS',
      actorType: 'ADMIN',
      actorId: meta.adminId,
      patientId: params.patientId,
      requestId: meta.requestId,
    });
    return this.audit.query(params);
  }
}
