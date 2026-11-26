import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../shared/application/job-queue.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import {
  ConversationMessageRepository,
  type ExpiredAgentLease,
} from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';

export const AGENT_LEASE_SWEEP_QUEUE = 'conversations.agent-lease-sweep';
/** Every minute (UTC): a lease is over at most ~1 min before its message goes back to the queue. */
export const AGENT_LEASE_SWEEP_CRON = '* * * * *';
/** Conversations per unit of work (each one locked, in (space, conversation) order). */
export const AGENT_LEASE_SWEEP_BATCH = 100;

export type AgentLeaseSweepResult = {
  /** Conversations swept (locked and requeued or cleared). */
  conversations: number;
  /** Messages back to `pending`. */
  requeued: number;
  /** Leases only cleared (answered or tombstoned messages). */
  cleared: number;
  /** Conversations left for the next run (owner changing, executor no longer the acking hub). */
  skipped: number;
};

type Resolved = {
  lease: ExpiredAgentLease;
  seen: Conversation;
  ownerScope: ConversationScope;
};

// Varredura do prazo do ack do agente (spec pc-agent §5.3, "Prazo do ack do agente"): tarefa agendada do pg-boss, a
// cada minuto. Um ack de Hub `pc` vencido (`acked_lease_until`, relógio do banco) sem resposta desse Hub volta a
// `pending` (`requeued_at` novo, prazo e ack limpos), o que dispara `CloudReservePendingHooks` (motivo `requeued`,
// `immediate`: o agente já teve os 15 min dele) dentro do mesmo unit of work, e a nuvem de reserva responde só com
// conhecimento. Hoje a tarefa da nuvem começa na hora, mas `nextResponderStep` conta os 30 s do Hub de novo a partir do
// `requeued_at`: a resposta sai ~30 s depois da varredura (CLAUDE.md, Pendências, "Agente do PC"). Mensagem já respondida pelo agente (mensagem dele com `answers_message_id` = ela) ou apagada: só o
// prazo sai.
// Depois disso o agente atrasado perde a vez como um Hub que perdeu a mensagem: passo e renovação 409
// `brain-step-not-owned` (`AgentTurn`: a mensagem não é mais dele) e, pega pela nuvem, ack 404 `message-not-found`.
// Como o executor perdido (`ConversationsExecutorLostHook`): os candidatos vêm do contexto `app.agent_lease_sweep` (só
// ids das linhas com prazo), o assunto é lido no contexto do Hub que confirmou (um prazo sempre é do executor atual: a
// troca de executor limpa os prazos dele em `requeueAckedBy`) e a escrita roda no contexto do DONO do assunto. Lotes de
// até 100 assuntos por unit of work, travados `FOR NO KEY UPDATE` (como o ack) em ordem (espaço, assunto); os
// candidatos vêm por cursor (assunto, Hub), então uma passada vê cada um uma vez e os pulados (o dono que mudou entre a
// leitura e a trava) ficam para a próxima passada sem esconder os de trás. Idempotente (tudo reconferido sob a trava, pelo
// relógio do banco); o registro leva só contagens.
@Injectable()
export class AgentLeaseSweepJob implements OnModuleInit {
  private readonly logger = new Logger(AgentLeaseSweepJob.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly reserve: ConversationCloudReserve,
    private readonly uow: UnitOfWork,
    private readonly jobs: JobQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.work(AGENT_LEASE_SWEEP_QUEUE, async () => {
      const result = await this.run();
      if (result.conversations > 0 || result.skipped > 0) {
        this.logger.log(`agent lease sweep: ${JSON.stringify(result)}`);
      }
    });
    await this.jobs.schedule(AGENT_LEASE_SWEEP_QUEUE, AGENT_LEASE_SWEEP_CRON);
  }

  async run(
    batchSize: number = AGENT_LEASE_SWEEP_BATCH,
  ): Promise<AgentLeaseSweepResult> {
    const total: AgentLeaseSweepResult = {
      conversations: 0,
      requeued: 0,
      cleared: 0,
      skipped: 0,
    };
    // Keyset over (conversation, hub): one pass walks every candidate once and always ends (the cursor only moves
    // forward), and skipped conversations never starve the ones behind them; they come back on the next run.
    let after: ExpiredAgentLease | null = null;
    for (;;) {
      const { leases, ...batch } = await this.uow.run(() =>
        this.batch(batchSize, after),
      );
      total.conversations += batch.conversations;
      total.requeued += batch.requeued;
      total.cleared += batch.cleared;
      total.skipped += batch.skipped;
      if (leases.length < batchSize) return total;
      after = leases[leases.length - 1];
    }
  }

  private async batch(
    batchSize: number,
    after: ExpiredAgentLease | null,
  ): Promise<AgentLeaseSweepResult & { leases: ExpiredAgentLease[] }> {
    const result = { conversations: 0, requeued: 0, cleared: 0, skipped: 0 };
    const leases = await this.messages.listExpiredAgentLeases(batchSize, after);
    const resolved: Resolved[] = [];
    for (const lease of leases) {
      const hubScope: ConversationScope = {
        organizationId: lease.organizationId,
        actor: { kind: 'hub', hubId: lease.hubId },
      };
      const seen = await this.conversations.findById(
        hubScope,
        lease.conversationId,
        { withDeleted: true },
      );
      if (!seen || !seen.isExecutor(lease.hubId)) {
        result.skipped += 1;
        continue;
      }
      resolved.push({
        lease,
        seen,
        ownerScope: {
          organizationId: lease.organizationId,
          actor: { kind: 'user', userId: seen.ownerUserId },
        },
      });
    }
    // The global order of conversation locks: (space, conversation), as Postgres orders uuids (lowercase hex).
    const key = (r: Resolved) => `${r.seen.spaceId}/${r.seen.id}`;
    resolved.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    for (const { lease, seen, ownerScope } of resolved) {
      if (seen.deletedAt) {
        // Tombstoned (moved): nothing answers there any more; the leases just go (no lock: the conversation is dead,
        // and its reserve is off, so there is no signal).
        const gone = await this.messages.requeueExpiredAgentLeases(
          ownerScope,
          lease.conversationId,
        );
        result.conversations += 1;
        result.requeued += gone.requeued.length;
        result.cleared += gone.cleared;
        continue;
      }
      const conversation = await this.conversations.lockById(
        ownerScope,
        lease.conversationId,
        'no-key-update',
      );
      if (!conversation || !conversation.isOwner(seen.ownerUserId)) {
        result.skipped += 1;
        continue;
      }
      const { requeued, cleared } =
        await this.messages.requeueExpiredAgentLeases(
          ownerScope,
          conversation.id,
        );
      for (const messageId of requeued) {
        await this.reserve.signal(conversation, messageId, 'requeued', {
          immediate: true,
        });
      }
      result.conversations += 1;
      result.requeued += requeued.length;
      result.cleared += cleared;
    }
    return { ...result, leases };
  }
}
