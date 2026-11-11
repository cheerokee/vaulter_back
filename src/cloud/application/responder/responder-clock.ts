import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * The responder's "now": the DATABASE clock (`clock_timestamp()`), the same clock as the messages' `sentAt` /
 * `requeuedAt` and pg-boss's start times, so the Hub's 30 s window does not move with an app server's clock. A provider
 * of its own so the e2e can move it (`createTestApp({ overrides })`) instead of sleeping 30 s.
 */
@Injectable()
export class ResponderClock {
  constructor(private readonly dataSource: DataSource) {}

  async now(): Promise<Date> {
    const rows: { now: Date }[] = await this.dataSource.query(
      `SELECT clock_timestamp() AS now`,
    );
    return rows[0]!.now;
  }
}
