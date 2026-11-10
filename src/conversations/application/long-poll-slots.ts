import { Injectable } from '@nestjs/common';
import {
  CONVERSATION_LONG_POLLS_PER_HUB,
  CONVERSATION_LONG_POLLS_TOTAL,
} from '../domain/conversation-limits.js';

/**
 * Counts the executor long polls waiting in THIS API instance: at most `perHub` per Hub and `total` overall. A slot is
 * held only while a request may wait (never during the response); over a cap the request answers without waiting.
 */
@Injectable()
export class LongPollSlots {
  private readonly byHub = new Map<string, number>();
  private used = 0;
  private perHub = CONVERSATION_LONG_POLLS_PER_HUB;
  private total = CONVERSATION_LONG_POLLS_TOTAL;

  /** Other caps (tests). Nest builds the default one. */
  static withCaps(perHub: number, total: number): LongPollSlots {
    const slots = new LongPollSlots();
    slots.perHub = perHub;
    slots.total = total;
    return slots;
  }

  /** The release function (idempotent), or null when a cap is reached. */
  tryAcquire(hubId: string): (() => void) | null {
    const current = this.byHub.get(hubId) ?? 0;
    if (current >= this.perHub || this.used >= this.total) return null;
    this.byHub.set(hubId, current + 1);
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      const left = (this.byHub.get(hubId) ?? 1) - 1;
      if (left > 0) this.byHub.set(hubId, left);
      else this.byHub.delete(hubId);
    };
  }

  inUse(hubId: string): number {
    return this.byHub.get(hubId) ?? 0;
  }
}
