import { Injectable } from '@nestjs/common';
import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { EnrollmentRepository } from '../domain/enrollment.repository.js';
import {
  HUB_LABELS,
  isFreshHubTimestamp,
  isIsoUtcTimestamp,
} from '../domain/hub-signed-message.js';
import { HubSignatureVerifier } from './ports/hub-signature-verifier.js';

export type EnrollmentStatusInput = {
  enrollmentId: string;
  /** `X-Hub-Timestamp`: ISO 8601 UTC, within ±5 min. */
  timestamp: string;
  /** `X-Hub-Signature`: Ed25519 over `hub-status-v1` and `{ enrollmentId, timestamp }`. */
  signature: string;
};

export type EnrollmentStatusResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'claimed'; hubId: string };

function enrollmentNotFound(): NotFoundError {
  return new NotFoundError(
    'enrollment-not-found',
    'The enrollment was not found.',
  );
}

// O Hub descobre se foi reivindicado (rota pública). O formato e a janela do timestamp (que não dependem do
// banco) dão 422; apresentação inexistente, id malformado e assinatura inválida dão o MESMO 404 (sem oráculo:
// sem a chave privada não se aprende nada sobre uma apresentação).
@Injectable()
export class EnrollmentStatusUseCase {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly verifier: HubSignatureVerifier,
  ) {}

  async execute(input: EnrollmentStatusInput): Promise<EnrollmentStatusResult> {
    const now = new Date();
    if (!isIsoUtcTimestamp(input.timestamp)) {
      throw new DomainValidationError(
        'timestamp-invalid',
        'The timestamp must be an ISO 8601 UTC instant.',
      );
    }
    if (!isFreshHubTimestamp(input.timestamp, now)) {
      throw new DomainValidationError(
        'timestamp-out-of-window',
        'The timestamp is too far from the server clock.',
      );
    }
    const enrollment = await this.enrollments.findById(input.enrollmentId);
    const signed = await this.verifier.verify(
      HUB_LABELS.status,
      { enrollmentId: input.enrollmentId, timestamp: input.timestamp },
      input.signature,
      enrollment?.signingPublicKey ?? this.verifier.decoyPublicKey(),
    );
    if (!enrollment || !signed) throw enrollmentNotFound();

    if (enrollment.status === 'claimed' && enrollment.claimedHubId) {
      return { status: 'claimed', hubId: enrollment.claimedHubId };
    }
    if (
      enrollment.status === 'expired' ||
      now.getTime() >= enrollment.expiresAt.getTime()
    ) {
      return { status: 'expired' };
    }
    return { status: 'pending' };
  }
}
