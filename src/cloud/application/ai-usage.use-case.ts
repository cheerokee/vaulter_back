import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import {
  aiBudgetWarningLevel,
  type AiBudgetWarningLevel,
} from '../../organizations/application/organization-ai-budget.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import type { AiUsageKind } from '../domain/ai-usage.js';
import { AiUsageLedger } from '../domain/ai-usage.repository.js';
import { AiBudget } from './ai-budget.js';

/** Micro-USD as a JSON number (exact up to 2^53 - 1: the budget never goes beyond). */
const money = (v: bigint): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('AI amount out of range');
  return n;
};

export type AiUsageView = {
  organizationId: string;
  /** `YYYY-MM` (UTC calendar month, database clock). */
  month: string;
  /** When the month ends and the budget starts again. */
  resetsAt: Date;
  budgetMicroUsd: number;
  /** Settled spend of the month. */
  spentMicroUsd: number;
  /** Calls in progress (reserved, not settled yet). */
  reservedMicroUsd: number;
  /** `budget - spent - reserved`, never below 0. */
  remainingMicroUsd: number;
  /** 0, 75, 90 or 100: highest threshold reached by spent + reserved (a budget of 0 is 100). */
  warningLevel: AiBudgetWarningLevel;
  /** What each space spent on each kind this month (space id order). No content: ids, counts, costs. */
  items: {
    spaceId: string;
    kind: AiUsageKind;
    costMicroUsd: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
  }[];
};

// Uso de IA do mês corrente (spec active-cloud §4.4: "medição por uso (por espaço e por tipo), visível para admins").
// Exige `org.billing` (o `org_admin`; 404 para não membro, 403 para membro sem a permissão). Leitura sem trava.
@Injectable()
export class GetAiUsageUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
    private readonly budget: AiBudget,
    private readonly ledger: AiUsageLedger,
  ) {}

  async execute(actor: Actor, orgId: string): Promise<AiUsageView> {
    await this.access.requirePermission(orgId, actor.userId, 'org.billing');
    const budgetMicroUsd = await this.directory.aiBudget(orgId);
    if (budgetMicroUsd === null) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    const month = await this.budget.currentMonth(orgId);
    const lines = await this.ledger.currentMonthLines(orgId);
    const consumed = month.spentMicroUsd + month.reservedMicroUsd;
    const remaining = budgetMicroUsd - consumed;
    return {
      organizationId: orgId,
      month: month.month.slice(0, 7),
      resetsAt: month.resetsAt,
      budgetMicroUsd: money(budgetMicroUsd),
      spentMicroUsd: money(month.spentMicroUsd),
      reservedMicroUsd: money(month.reservedMicroUsd),
      remainingMicroUsd: money(remaining > 0n ? remaining : 0n),
      warningLevel: aiBudgetWarningLevel(budgetMicroUsd, consumed),
      items: lines.map((l) => ({
        spaceId: l.spaceId,
        kind: l.kind,
        costMicroUsd: money(l.costMicroUsd),
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        calls: l.calls,
      })),
    };
  }
}
