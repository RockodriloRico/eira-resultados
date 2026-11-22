import type { AdminPatientView } from '@eira/shared';
import type { AppConfig } from '../config.ts';
import { identityHashes, maskPhone, normalizeFolio } from '../domain/identity.ts';
import { HttpError } from '../http/responses.ts';
import { hmac } from '../security/crypto.ts';
import { isConditionFailure } from '../repositories/db.ts';
import type { SecretsProvider } from '../security/secrets.ts';
import type { AuditRepository } from '../repositories/auditRepository.ts';
import type { PatientRecord, PatientsRepository } from '../repositories/patientsRepository.ts';

export type Clock = () => Date;
export type ActorMeta = { adminId: string; requestId?: string };

export const toAdminPatientView = (p: PatientRecord): AdminPatientView => ({
  patientId: p.patientId,
  status: p.status,
  dataClassification: p.dataClassification,
  phoneMasked: maskPhone(p.phoneE164),
  createdAt: p.createdAt,
});

export class PatientService {
  private readonly deps: {
    config: Pick<AppConfig, 'stage'>;
    patients: PatientsRepository;
    audit: AuditRepository;
    secrets: SecretsProvider;
    clock: Clock;
  };
  constructor(deps: PatientService['deps']) {
    this.deps = deps;
  }

  async create(
    input: { fullName: string; birthDate: string; folio: string; phone: string },
    meta: ActorMeta,
  ): Promise<AdminPatientView> {
    const { patients, audit, secrets, clock, config } = this.deps;
    const { identity } = await secrets.get();
    const hashes = identityHashes(identity, input);
    if ((await patients.findIdsByFolioHash(hashes.folioHash)).length > 0) {
      throw new HttpError(409, 'Ya existe un expediente con ese folio');
    }
    const now = clock();
    const record: PatientRecord = {
      // Derivado del folio: dos altas concurrentes del mismo folio chocan en attribute_not_exists.
      patientId: `pat_${hmac(identity, `patientId:${hashes.folioHash}`).slice(0, 22)}`,
      ...hashes,
      phoneE164: input.phone,
      status: 'ACTIVE',
      // Hasta que EIRA apruebe datos reales, todo expediente es sintético; demo lo exige.
      dataClassification: config.stage === 'prod' ? 'CONFIDENTIAL' : 'SYNTHETIC',
      createdAt: now.toISOString(),
      createdBy: meta.adminId,
    };
    const auditItem = audit.transactPut(
      {
        eventType: 'PATIENT_CREATED',
        outcome: 'SUCCESS',
        actorType: 'ADMIN',
        actorId: meta.adminId,
        patientId: record.patientId,
        requestId: meta.requestId,
      },
      now,
    );
    try {
      await patients.create(record, auditItem);
    } catch (error) {
      if (isConditionFailure(error))
        throw new HttpError(409, 'Ya existe un expediente con ese folio');
      throw error;
    }
    return toAdminPatientView(record);
  }

  /** Búsqueda exacta por folio (no hay Scan). */
  async findByFolio(folio: string, meta: ActorMeta): Promise<AdminPatientView | undefined> {
    const { identity } = await this.deps.secrets.get();
    const folioHash = identityHashes(identity, {
      folio: normalizeFolio(folio),
      fullName: '',
      birthDate: '',
    }).folioHash;
    const [patientId] = await this.deps.patients.findIdsByFolioHash(folioHash);
    return patientId ? this.get(patientId, meta) : undefined;
  }

  async get(patientId: string, meta: ActorMeta): Promise<AdminPatientView | undefined> {
    const record = await this.deps.patients.get(patientId);
    if (!record) return undefined;
    await this.deps.audit.append(
      {
        eventType: 'PATIENT_VIEWED',
        outcome: 'SUCCESS',
        actorType: 'ADMIN',
        actorId: meta.adminId,
        patientId,
        requestId: meta.requestId,
      },
      this.deps.clock(),
    );
    return toAdminPatientView(record);
  }
}
