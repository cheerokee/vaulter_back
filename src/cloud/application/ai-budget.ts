import { Injectable } from '@nestjs/common';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { newId } from '../../shared/domain/id.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  AI_RESERVATION_TTL_SECONDS,
  AiBudgetExceededError,
  reservationFits,
  type AiBudgetMonth,
  type AiReservation,
  type AiSpend,
  type AiUsageKind,
} from '../domain/ai-usage.js';
import { AiUsageLedger } from '../domain/ai-usage.repository.js';

export type AiReservationRequest = {
  organizationId: string;
  spaceId: string;
  kind: AiUsageKind;
  /** Upper estimate of the call's cost (`AiPricing.costMicroUsd` of the estimated tokens). */
  estimatedMicroUsd: bigint;
};

/** Refused: the month's budget has no room; `resetsAt` = when the next month starts (UTC). */
export type AiReservationRefusal = { resetsAt: Date };

/**
 * Runs under the organization lock, in the same transaction that refused the reservation (e.g. the indexing schedules
 * its resume for the next month). Must not take locks other than leaf rows of the cloud module.
 */
export type OnAiReservationRefused = (
  refusal: AiReservationRefusal,
) => Promise<void>;

// Orçamento mensal de IA (spec active-cloud §4.4): TODA chamada que custa (lote de embeddings da indexação, resposta
// da nuvem) passa por aqui, assim:
//   const r = await budget.reserve({ organizationId, spaceId, kind, estimatedMicroUsd }); // 422 ai-budget-exceeded
//   try { const out = await chamada(); await budget.settle(r, gastoReal); } catch (e) { await budget.release(r); throw e; }
// - `reserve` é uma transação CURTA própria: trava a linha da organização (`OrganizationDirectory.lockAiBudget`,
//   FOR NO KEY UPDATE, folha: nada é travado depois dela além das linhas do livro), marca como `expired` as reservas
//   esquecidas, lê gasto + reservas vivas do mês em UM comando e grava a reserva se couber. Reservas concorrentes se
//   serializam na linha da organização: a soma nunca passa do orçamento.
// - A chamada de rede (modelo/embeddings) roda FORA de qualquer transação (nenhuma trava nem conexão do pool presa).
// - `settle` (outra transação curta) grava o gasto real no mês da reserva; `release` devolve a reserva sem gasto (a
//   chamada falhou). Nenhum dos dois trava a organização. Idempotentes (a segunda chamada não grava nada).
// - Reserva esquecida (o processo caiu entre reservar e acertar): conta por `AI_RESERVATION_TTL_SECONDS` e depois para
//   de contar; um acerto tardio ainda grava o gasto real.
// NUNCA chamar `reserve` dentro de um unit of work aberto: viraria savepoint e seguraria a trava da organização até o
// COMMIT de quem chamou (lança erro). O gasto real pode passar um pouco do estimado (a estimativa é por cima, mas o
// acerto grava o real): o mês pode fechar levemente acima de 100%.
@Injectable()
export class AiBudget {
  constructor(
    private readonly directory: OrganizationDirectory,
    private readonly ledger: AiUsageLedger,
    private readonly uow: UnitOfWork,
  ) {}

  /** Reserves or throws 422 `ai-budget-exceeded` (with `resetsAt`). */
  async reserve(request: AiReservationRequest): Promise<AiReservation> {
    const outcome = await this.tryReserve(request);
    if ('refusal' in outcome) {
      throw new AiBudgetExceededError(outcome.refusal.resetsAt);
    }
    return outcome.reservation;
  }

  /**
   * Same, without throwing on a refusal; `onRefused` runs in the refusing transaction, still under the organization
   * lock (a budget raise, which takes the same lock, then sees what it wrote). Unknown organization: refused.
   */
  async tryReserve(
    request: AiReservationRequest,
    onRefused?: OnAiReservationRefused,
  ): Promise<
    { reservation: AiReservation } | { refusal: AiReservationRefusal }
  > {
    if (
      typeof request.estimatedMicroUsd !== 'bigint' ||
      request.estimatedMicroUsd < 0n
    ) {
      throw new Error('estimatedMicroUsd must be a non-negative bigint');
    }
    if (this.uow.isActive()) {
      throw new Error(
        'AiBudget.reserve must run outside a unit of work (it holds the organization lock only for its own short transaction).',
      );
    }
    return this.uow.run(async () => {
      const budget = await this.directory.lockAiBudget(request.organizationId);
      await this.ledger.expireStale(request.organizationId);
      const month = await this.ledger.currentMonth(request.organizationId);
      if (
        budget === null ||
        !reservationFits(budget, month, request.estimatedMicroUsd)
      ) {
        const refusal = { resetsAt: month.resetsAt };
        if (onRefused) await onRefused(refusal);
        return { refusal };
      }
      const reservation: AiReservation = {
        id: newId(),
        organizationId: request.organizationId,
        spaceId: request.spaceId,
        kind: request.kind,
        month: month.month,
        amountMicroUsd: request.estimatedMicroUsd,
      };
      await this.ledger.insertReservation(
        reservation,
        AI_RESERVATION_TTL_SECONDS,
      );
      return { reservation };
    });
  }

  /** Records the real spend (in the reservation's month); a second settle or one after a release writes nothing. */
  async settle(reservation: AiReservation, spend: AiSpend): Promise<void> {
    await this.uow.run(() =>
      this.ledger.settle(reservation.organizationId, reservation.id, spend),
    );
  }

  /**
   * Renews a live reservation for another `AI_RESERVATION_TTL_SECONDS` from now (a long job calls it between its
   * calls, so a crash still frees the budget within the TTL). No lock on the organization: extending only shrinks the
   * room of the others. An already expired, settled or released reservation is left as it is (a late settle still
   * records the spend).
   */
  async keepAlive(reservation: AiReservation): Promise<void> {
    await this.ledger.extend(
      reservation.organizationId,
      reservation.id,
      AI_RESERVATION_TTL_SECONDS,
    );
  }

  /** Gives the reservation back without spend (the call failed before costing anything). */
  async release(reservation: AiReservation): Promise<void> {
    await this.ledger.release(reservation.organizationId, reservation.id);
  }

  /** Spent + live reservations of the current month (views; no lock). */
  async consumedMicroUsd(organizationId: string): Promise<bigint> {
    const month = await this.ledger.currentMonth(organizationId);
    return month.spentMicroUsd + month.reservedMicroUsd;
  }

  /** The current month's state (views; no lock). */
  currentMonth(organizationId: string): Promise<AiBudgetMonth> {
    return this.ledger.currentMonth(organizationId);
  }
}
