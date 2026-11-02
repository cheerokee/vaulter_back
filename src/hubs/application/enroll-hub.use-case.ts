import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  DomainValidationError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import { Enrollment } from '../domain/enrollment.js';
import { EnrollmentRepository } from '../domain/enrollment.repository.js';
import {
  assertEncryptionPublicKey,
  assertEnrollmentNonce,
  assertSigningPublicKey,
} from '../domain/hub-keys.js';
import {
  HUB_LABELS,
  isFreshHubTimestamp,
  isIsoUtcTimestamp,
} from '../domain/hub-signed-message.js';
import { HubRepository } from '../domain/hub.repository.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubCodeHasher } from './ports/hub-code-hasher.js';
import { HubSignatureVerifier } from './ports/hub-signature-verifier.js';

export type EnrollHubInput = {
  signingPublicKey: string;
  encryptionPublicKey: string;
  /** 16 random bytes, base64url: single use per signing key. */
  nonce: string;
  /** ISO 8601 UTC; must be within ±5 min of the server clock. */
  timestamp: string;
  /** Ed25519 over `hub-enroll-v1` and the four fields above. */
  signature: string;
};

export type EnrollHubResult = {
  enrollmentId: string;
  /** Shown once (the Hub displays or speaks it); only its keyed hash is stored. */
  claimCode: string;
  expiresAt: Date;
};

// Tentativas quando o código sorteado já pertence a outra apresentação pendente (10^8 códigos: raríssimo).
const MAX_CODE_ATTEMPTS = 5;

export function hubSignatureInvalid(): UnauthenticatedError {
  return new UnauthenticatedError(
    'hub-signature-invalid',
    'The hub signature is invalid.',
  );
}

// Apresentação de um Hub sem dono (rota pública). Formato (422) antes de tudo; depois a janela do timestamp e a
// assinatura, que prova a posse da chave privada; chave já usada por um Hub (inclusive desregistrado, a chave é
// de um Hub só para sempre) é 409 `signing-key-in-use`; o (chave, nonce) repetido é 409 `nonce-reused`. Expira as
// pendentes vencidas antes de gravar (libera os hashes de código delas) e, a cada tentativa, a pendente anterior
// da mesma chave (spec §5: uma pendente por chave; vale a apresentação mais nova, e o código antigo morre). Duas
// apresentações simultâneas da mesma chave: o índice único recusa a segunda (`enrollment-pending-for-key`), que
// expira a primeira e tenta de novo. Expirar e gravar vão numa transação: um replay (nonce repetido) não derruba
// a pendente legítima.
@Injectable()
export class EnrollHubUseCase {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly hubs: HubRepository,
    private readonly verifier: HubSignatureVerifier,
    private readonly codes: HubCodeHasher,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(input: EnrollHubInput): Promise<EnrollHubResult> {
    const now = new Date();
    const keys = {
      signingPublicKey: assertSigningPublicKey(input.signingPublicKey),
      encryptionPublicKey: assertEncryptionPublicKey(input.encryptionPublicKey),
    };
    const nonce = assertEnrollmentNonce(input.nonce);
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
    const signed = await this.verifier.verify(
      HUB_LABELS.enroll,
      { ...keys, nonce, timestamp: input.timestamp },
      input.signature,
      keys.signingPublicKey,
    );
    if (!signed) throw hubSignatureInvalid();

    if ((await this.hubs.findBySigningKey(keys.signingPublicKey)) !== null) {
      throw new ConflictError(
        'signing-key-in-use',
        'This device key already belongs to a hub. Reset the device to enroll it again.',
      );
    }
    await this.enrollments.expireStale(now);

    for (let attempt = 1; ; attempt++) {
      const claimCode = this.codes.newCode();
      const enrollment = Enrollment.issue({
        keys,
        nonce,
        codeHash: await this.codes.hash(claimCode),
        now,
      });
      try {
        // Uma transação: se a gravação falhar (ex.: nonce repetido de um replay), a pendente anterior não expira.
        await this.uow.run(async () => {
          await this.enrollments.expirePendingOfKey(keys.signingPublicKey);
          await this.enrollments.create(enrollment);
        });
      } catch (error) {
        if (
          error instanceof ConflictError &&
          (error.code === 'claim-code-collision' ||
            error.code === 'enrollment-pending-for-key') &&
          attempt < MAX_CODE_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
      return {
        enrollmentId: enrollment.id,
        claimCode,
        expiresAt: enrollment.expiresAt,
      };
    }
  }
}
