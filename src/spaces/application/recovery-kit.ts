import { Injectable } from '@nestjs/common';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { assertRecoveryPublicKey } from '../domain/recovery-public-key.js';
import type { SpaceKeyVersion } from '../domain/space-key.repository.js';
import { KeyFingerprinter } from './ports/key-fingerprinter.js';

// Kit de recuperação da organização visto pelo `spaces` (decisão 2). Toda operação que grava uma
// `recovery_wrapped_key` recebe do app a chave pública do kit que ele usou e confere que é o kit ATUAL; a
// impressão gravada vem sempre da chave da organização, nunca do cliente. "Retrancar pendente" é calculado.
// Nenhuma mensagem de erro carrega a chave.
@Injectable()
export class RecoveryKit {
  constructor(
    private readonly directory: OrganizationDirectory,
    private readonly fingerprinter: KeyFingerprinter,
  ) {}

  /** Fingerprint of the organization's current kit, or null when it has none. */
  async currentFingerprint(orgId: string): Promise<string | null> {
    const key = await this.directory.recoveryPublicKey(orgId);
    return key ? this.fingerprinter.fingerprint(key) : null;
  }

  /**
   * The app's key must be the organization's current kit. No kit: 422 `recovery-key-required`; another key:
   * 409 `recovery-key-changed` (the app reloads). Returns the fingerprint of the ORGANIZATION's key.
   */
  async assertCurrent(orgId: string, clientPublicKey: string): Promise<string> {
    assertRecoveryPublicKey(clientPublicKey);
    const orgKey = await this.directory.recoveryPublicKey(orgId);
    if (!orgKey) {
      throw new DomainValidationError(
        'recovery-key-required',
        'The organization must register a recovery kit first.',
      );
    }
    const [orgFingerprint, clientFingerprint] = await Promise.all([
      this.fingerprinter.fingerprint(orgKey),
      this.fingerprinter.fingerprint(clientPublicKey),
    ]);
    if (orgFingerprint !== clientFingerprint) {
      throw new ConflictError(
        'recovery-key-changed',
        'The recovery kit of the organization has changed.',
      );
    }
    return orgFingerprint;
  }

  /** True when any version is still wrapped for another kit; false when the organization has no kit. */
  async isRewrapRequired(
    orgId: string,
    versions: readonly SpaceKeyVersion[],
  ): Promise<boolean> {
    const current = await this.currentFingerprint(orgId);
    return (
      current !== null &&
      versions.some((v) => v.recoveryKeyFingerprint !== current)
    );
  }
}
