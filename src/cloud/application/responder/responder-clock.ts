import { Injectable } from '@nestjs/common';

/**
 * The responder's "now" (when a pending message becomes the cloud's: `sentAt + CLOUD_FALLBACK_AFTER_MS`). A provider of
 * its own so the e2e can move it (`createTestApp({ overrides })`) instead of sleeping 30 s.
 */
@Injectable()
export class ResponderClock {
  now(): Date {
    return new Date();
  }
}
