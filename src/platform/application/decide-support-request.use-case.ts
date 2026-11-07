import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { DomainError, NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SupportRequest } from '../domain/support-request.js';
import { SupportRequestRepository } from '../domain/support-request.repository.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';
import {
  persistExpiry,
  supportRequestAuditEntry,
} from './support-request-audit.js';
import { SupportRequestExecutor } from './support-request-executor.js';

export function supportRequestNotFound(): NotFoundError {
  return new NotFoundError(
    'support-request-not-found',
    'The support request was not found.',
  );
}

type Decision = { kind: 'approve' } | { kind: 'reject'; note: string };

// Aprova (e executa na hora) ou recusa um pedido pendente de OUTRA pessoa (spec §4.3). Ordem:
// 1. permissão (404 sem `platform.support.approve`) e pedido existente (404), sem gastar o Argon2;
// 2. reautenticação FORA da transação;
// 3. na transação: trava a linha do pedido (FOR UPDATE: duas decisões concorrentes se serializam, a segunda vê o
//    pedido já decidido, 409), reconfere a permissão, decide, grava, audita e, na aprovação, executa.
// Vencido (7 dias sem decisão): o estado `expired` é gravado e auditado, a transação confirma, e SÓ ENTÃO sai o
// 422 `support-request-expired` (lançar dentro do `run` desfaria a gravação).
@Injectable()
export class DecideSupportRequestUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly repo: SupportRequestRepository,
    private readonly audit: PlatformAudit,
    private readonly executor: SupportRequestExecutor,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly uow: UnitOfWork,
  ) {}

  approve(
    actor: Actor,
    id: string,
    input: { currentAuthProof: string },
  ): Promise<SupportRequest> {
    return this.decide(actor, id, input.currentAuthProof, { kind: 'approve' });
  }

  reject(
    actor: Actor,
    id: string,
    input: { note: string; currentAuthProof: string },
  ): Promise<SupportRequest> {
    return this.decide(actor, id, input.currentAuthProof, {
      kind: 'reject',
      note: input.note,
    });
  }

  private async decide(
    actor: Actor,
    id: string,
    currentAuthProof: string,
    decision: Decision,
  ): Promise<SupportRequest> {
    await this.access.require(actor.userId, 'platform.support.approve');
    if (!(await this.repo.findById(id))) throw supportRequestNotFound();
    await this.verifier.verify(actor.userId, currentAuthProof);

    const outcome = await this.uow.run(
      async (): Promise<
        { request: SupportRequest } | { error: DomainError }
      > => {
        const request = await this.repo.lockById(id);
        if (!request) throw supportRequestNotFound();
        await this.access.require(actor.userId, 'platform.support.approve');
        const now = new Date();
        const wasPending = request.status === 'pending';
        try {
          if (decision.kind === 'approve') {
            request.approve(actor.userId, now);
          } else {
            request.reject(actor.userId, decision.note, now);
          }
        } catch (err) {
          // A pending request that was due: the domain turned it `expired` before refusing; keep that state.
          if (
            err instanceof DomainError &&
            err.code === 'support-request-expired' &&
            wasPending
          ) {
            await persistExpiry(request, this.repo, this.audit);
            return { error: err };
          }
          throw err;
        }
        await this.repo.save(request);
        await this.audit.record(
          supportRequestAuditEntry(
            request,
            decision.kind === 'approve'
              ? 'platform.request.approved'
              : 'platform.request.rejected',
            actor.userId,
          ),
        );
        if (decision.kind === 'approve') {
          await this.executor.execute(request, now);
        }
        return { request };
      },
    );
    if ('error' in outcome) throw outcome.error;
    return outcome.request;
  }
}
