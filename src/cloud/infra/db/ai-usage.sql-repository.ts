import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type {
  AiBudgetMonth,
  AiReservation,
  AiSpend,
  AiUsageKind,
} from '../../domain/ai-usage.js';
import {
  AiUsageLedger,
  type AiUsageLine,
} from '../../domain/ai-usage.repository.js';

/** The UTC calendar month of the transaction's `now()` (database clock), as a `date`. */
const MONTH_SQL = `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;

const count = (v: string | number): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid AI usage count from the database: ${String(v)}`);
  }
  return n;
};

// O livro de uso em SQL (spec active-cloud §4.4). Mês = mês civil UTC pelo relógio do banco (`now()` da transação).
// A soma do mês (gasto acertado + reservas vivas) sai de UM comando: sob READ COMMITTED cada comando tem o próprio
// retrato, então dois SELECTs separados poderiam ver um acerto pela metade (a reserva já `settled` num, o gasto ainda
// não somado no outro) e deixar passar uma reserva além do orçamento.
@Injectable()
export class AiUsageSqlLedger extends AiUsageLedger {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async currentMonth(orgId: string): Promise<AiBudgetMonth> {
    const [row] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `WITH m AS (SELECT ${MONTH_SQL} AS month)
           SELECT to_char(m.month, 'YYYY-MM-DD') AS month,
                  ((m.month + interval '1 month')::timestamp AT TIME ZONE 'UTC') AS resets_at,
                  (SELECT COALESCE(SUM(u.cost_micro_usd), 0) FROM cloud_ai_usage u
                    WHERE u.organization_id = $1 AND u.month = m.month)::text AS spent,
                  (SELECT COALESCE(SUM(r.amount_micro_usd), 0) FROM cloud_ai_reservations r
                    WHERE r.organization_id = $1 AND r.month = m.month
                      AND r.status = 'reserved' AND r.expires_at > now())::text AS reserved
             FROM m`,
          [orgId],
        ) as Promise<
          { month: string; resets_at: Date; spent: string; reserved: string }[]
        >,
    );
    return {
      month: row!.month,
      resetsAt: new Date(row!.resets_at),
      spentMicroUsd: BigInt(row!.spent),
      reservedMicroUsd: BigInt(row!.reserved),
    };
  }

  async expireStale(orgId: string): Promise<number> {
    const [, affected]: [unknown[], number] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE cloud_ai_reservations SET status = 'expired', updated_at = now()
            WHERE organization_id = $1 AND status = 'reserved' AND expires_at <= now()`,
          [orgId],
        ),
    );
    return affected;
  }

  async insertReservation(r: AiReservation, ttlSeconds: number): Promise<void> {
    await runInOrganizationScope(this.dataSource, r.organizationId, (m) =>
      m.query(
        `INSERT INTO cloud_ai_reservations
           (id, organization_id, space_id, kind, month, amount_micro_usd, status, expires_at)
         VALUES ($1, $2, $3, $4, $5::date, $6::bigint, 'reserved', now() + make_interval(secs => $7))`,
        [
          r.id,
          r.organizationId,
          r.spaceId,
          r.kind,
          r.month,
          r.amountMicroUsd.toString(),
          ttlSeconds,
        ],
      ),
    );
  }

  async settle(
    orgId: string,
    reservationId: string,
    spend: AiSpend,
  ): Promise<boolean> {
    if (!currentManager(this.dataSource).queryRunner?.isTransactionActive) {
      throw new Error(
        'AiUsageLedger.settle requires an active unit of work (call it inside UnitOfWork.run).',
      );
    }
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const [rows]: [
        { space_id: string; kind: AiUsageKind; month: string }[],
        number,
      ] = await m.query(
        `UPDATE cloud_ai_reservations
            SET status = 'settled', settled_at = now(), updated_at = now(), model = $3,
                input_tokens = $4, output_tokens = $5, cost_micro_usd = $6::bigint
          WHERE organization_id = $1 AND id = $2 AND status IN ('reserved', 'expired')
          RETURNING space_id, kind, to_char(month, 'YYYY-MM-DD') AS month`,
        [
          orgId,
          reservationId,
          spend.model,
          spend.inputTokens,
          spend.outputTokens,
          spend.costMicroUsd.toString(),
        ],
      );
      const settled = rows[0];
      if (!settled) return false;
      await m.query(
        `INSERT INTO cloud_ai_usage
           (organization_id, space_id, kind, month, cost_micro_usd, input_tokens, output_tokens, calls)
         VALUES ($1, $2, $3, $4::date, $5::bigint, $6, $7, 1)
         ON CONFLICT ON CONSTRAINT uq_cloud_ai_usage_month_space_kind DO UPDATE SET
           cost_micro_usd = cloud_ai_usage.cost_micro_usd + EXCLUDED.cost_micro_usd,
           input_tokens = cloud_ai_usage.input_tokens + EXCLUDED.input_tokens,
           output_tokens = cloud_ai_usage.output_tokens + EXCLUDED.output_tokens,
           calls = cloud_ai_usage.calls + 1,
           updated_at = now()`,
        [
          orgId,
          settled.space_id,
          settled.kind,
          settled.month,
          spend.costMicroUsd.toString(),
          spend.inputTokens,
          spend.outputTokens,
        ],
      );
      return true;
    });
  }

  async extend(
    orgId: string,
    reservationId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const [, affected]: [unknown[], number] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE cloud_ai_reservations
              SET expires_at = now() + make_interval(secs => $3), updated_at = now()
            WHERE organization_id = $1 AND id = $2 AND status = 'reserved' AND expires_at > now()`,
          [orgId, reservationId, ttlSeconds],
        ),
    );
    return affected > 0;
  }

  async release(orgId: string, reservationId: string): Promise<boolean> {
    const [, affected]: [unknown[], number] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE cloud_ai_reservations SET status = 'released', updated_at = now()
            WHERE organization_id = $1 AND id = $2 AND status IN ('reserved', 'expired')`,
          [orgId, reservationId],
        ),
    );
    return affected > 0;
  }

  async currentMonthLines(orgId: string): Promise<AiUsageLine[]> {
    const rows: {
      space_id: string;
      kind: AiUsageKind;
      cost: string;
      input_tokens: string;
      output_tokens: string;
      calls: number;
    }[] = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `SELECT space_id, kind, cost_micro_usd::text AS cost, input_tokens::text AS input_tokens,
                output_tokens::text AS output_tokens, calls
           FROM cloud_ai_usage
          WHERE organization_id = $1 AND month = ${MONTH_SQL}
          ORDER BY space_id, kind`,
        [orgId],
      ),
    );
    return rows.map((r) => ({
      spaceId: r.space_id,
      kind: r.kind,
      costMicroUsd: BigInt(r.cost),
      inputTokens: count(r.input_tokens),
      outputTokens: count(r.output_tokens),
      calls: r.calls,
    }));
  }
}
