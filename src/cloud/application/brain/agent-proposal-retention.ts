import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../../shared/application/job-queue.js';
import { AgentIssuedProposals } from './agent-issued-proposals.js';

/** = the window of the policy `agent_proposal_retention` (migration MaintenanceTrustedContexts): change both. */
export const AGENT_PROPOSAL_RETENTION_DAYS = 30;
export const AGENT_PROPOSAL_RETENTION_BATCH = 1000;
export const AGENT_PROPOSAL_RETENTION_QUEUE = 'cloud.agent-proposal-retention';
/** Every day at 03:30 UTC (low traffic). */
export const AGENT_PROPOSAL_RETENTION_CRON = '30 3 * * *';

// Retenção de `agent_issued_proposals` (decisão B7): a linha só serve para conferir, no passo do cérebro, que a
// proposta de documento numa mensagem do agente foi emitida pelo back. Depois de 30 dias ela sai: uma proposta mais
// velha que isso deixa de valer (é tirada do histórico antes do modelo, como uma proposta inventada) e o agente propõe
// de novo se a pessoa ainda quiser gravar. Lotes de 1000 por transação curta; idempotente; o registro leva só a contagem.
@Injectable()
export class AgentProposalRetention implements OnModuleInit {
  private readonly logger = new Logger(AgentProposalRetention.name);

  constructor(
    private readonly proposals: AgentIssuedProposals,
    private readonly jobs: JobQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.work(AGENT_PROPOSAL_RETENTION_QUEUE, async () => {
      const deleted = await this.run();
      if (deleted > 0) {
        this.logger.log(`agent proposal retention: ${deleted} deleted`);
      }
    });
    await this.jobs.schedule(
      AGENT_PROPOSAL_RETENTION_QUEUE,
      AGENT_PROPOSAL_RETENTION_CRON,
    );
  }

  async run(batch: number = AGENT_PROPOSAL_RETENTION_BATCH): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.proposals.deleteExpired(batch);
      total += deleted;
      if (deleted < batch) return total;
    }
  }
}
