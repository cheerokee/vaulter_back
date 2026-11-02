import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { EnrollHubUseCase } from '../../application/enroll-hub.use-case.js';
import { EnrollmentStatusUseCase } from '../../application/enrollment-status.use-case.js';
import { EnrollHubDto } from './dto/hub.dto.js';

/** A header as one string ('' when missing or repeated): the use case answers every bad value with the same 404. */
const single = (value: string | string[] | undefined): string =>
  typeof value === 'string' ? value : '';

// Rotas públicas do aparelho (sem token; a prova é a assinatura Ed25519 do Hub). Internas: sem a tag `public`.
@ApiTags('hubs')
@Controller('hub-enrollments')
export class HubEnrollmentsController {
  constructor(
    private readonly enroll: EnrollHubUseCase,
    private readonly status: EnrollmentStatusUseCase,
  ) {}

  /** First contact of a device: the claim code is returned here, ONCE (only its keyed hash is stored). */
  @Public()
  @Throttle({ default: RATE_LIMITS.hubEnroll })
  @Post()
  async doEnroll(@Body() dto: EnrollHubDto) {
    const r = await this.enroll.execute({
      signingPublicKey: dto.signingPublicKey,
      encryptionPublicKey: dto.encryptionPublicKey,
      nonce: dto.nonce,
      timestamp: dto.timestamp,
      signature: dto.signature,
    });
    return {
      enrollmentId: r.enrollmentId,
      claimCode: r.claimCode,
      expiresAt: r.expiresAt.toISOString(),
    };
  }

  /**
   * The device polls whether it was claimed, signing `{ enrollmentId, timestamp }` (`hub-status-v1`) in the headers.
   * Unknown or malformed id, missing or bad signature: the same 404 `enrollment-not-found` (no `uuidPipe` here, on
   * purpose). Only the timestamp's format and window give 422 (they do not depend on the enrollment).
   */
  @Public()
  @Throttle({ default: RATE_LIMITS.hubStatus })
  @ApiHeader({ name: 'X-Hub-Signature', required: true })
  @ApiHeader({ name: 'X-Hub-Timestamp', required: true })
  @Get(':id/status')
  async doStatus(
    @Param('id') id: string,
    @Headers('x-hub-signature') signature: string | string[] | undefined,
    @Headers('x-hub-timestamp') timestamp: string | string[] | undefined,
  ) {
    return this.status.execute({
      enrollmentId: id,
      signature: single(signature),
      timestamp: single(timestamp),
    });
  }
}
