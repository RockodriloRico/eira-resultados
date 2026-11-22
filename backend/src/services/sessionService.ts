import type { AuditRepository } from '../repositories/auditRepository.ts';
import type { SessionsRepository } from '../repositories/sessionsRepository.ts';
import { sha256 } from '../security/crypto.ts';
import type { ClientMeta } from './accessService.ts';
import type { Clock } from './patientService.ts';

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/;

export type SessionPrincipal = { patientId: string; tokenHash: string };

export class SessionService {
  private readonly d: { sessions: SessionsRepository; audit?: AuditRepository; clock: Clock };
  constructor(deps: SessionService['d']) {
    this.d = deps;
  }

  /** Authorizer: lectura consistente en cada solicitud; vigente si no venció ni fue revocada. */
  async authorize(authorization: string | undefined): Promise<SessionPrincipal | undefined> {
    const match = BEARER_RE.exec(authorization ?? '');
    if (!match) return undefined;
    const tokenHash = sha256(match[1]!);
    const session = await this.d.sessions.get(tokenHash);
    const now = Math.floor(this.d.clock().getTime() / 1000);
    if (!session || session.revoked === true || session.expiresAt <= now) return undefined;
    return { patientId: session.patientId, tokenHash };
  }

  async logout(principal: SessionPrincipal, meta: ClientMeta): Promise<void> {
    await this.d.sessions.revoke(principal.tokenHash);
    await this.d.audit?.tryAppend({
      eventType: 'SESSION_REVOKED',
      outcome: 'SUCCESS',
      actorType: 'PATIENT',
      patientId: principal.patientId,
      requestId: meta.requestId,
    });
  }
}
