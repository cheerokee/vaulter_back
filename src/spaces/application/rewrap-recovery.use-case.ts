import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { ConflictError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertRecoveryPublicKey } from '../domain/recovery-public-key.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { assertWrappedKeys, type VersionGrantInput } from './dto/key-inputs.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

export type RewrapRecoveryInput = {
  recoveryPublicKey: string;
  versions: VersionGrantInput[];
};

function versionsMismatch(): ConflictError {
  return new ConflictError(
    'key-versions-mismatch',
    'The versions must be exactly the ones still wrapped for a previous kit, or all of them.',
  );
}

const sameSet = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  b.every((x) => a.includes(x));

// Retranca as versões para o kit ATUAL da organização (qualquer membro). O conjunto enviado precisa ser
// exatamente as versões cuja impressão difere da do kit atual, OU todas as versões (o app pode simplesmente
// retrancar tudo); qualquer outro conjunto (parcial, desconhecido, repetido, vazio) é 409
// `key-versions-mismatch`. O espaço fica travado: uma troca de chave concorrente não cria versão no meio.
@Injectable()
export class RewrapRecoveryUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly keys: SpaceKeyRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: RewrapRecoveryInput,
  ): Promise<{ versions: number[] }> {
    assertRecoveryPublicKey(input.recoveryPublicKey);
    assertWrappedKeys(input.versions.map((v) => v.wrappedKey));
    return this.uow.run(async () => {
      const { space } = await this.access.lockAsMember(spaceId, actor.userId);
      const orgId = space.organizationId;
      const fingerprint = await this.kit.assertCurrent(
        orgId,
        input.recoveryPublicKey,
      );
      const existing = await this.keys.versions(orgId, space.id);
      const submitted = input.versions.map((v) => v.version);
      const stale = existing
        .filter((v) => v.recoveryKeyFingerprint !== fingerprint)
        .map((v) => v.version);
      const all = existing.map((v) => v.version);
      if (
        submitted.length === 0 ||
        !(sameSet(submitted, stale) || sameSet(submitted, all))
      ) {
        throw versionsMismatch();
      }
      const ordered = [...input.versions].sort((a, b) => a.version - b.version);
      for (const v of ordered) {
        await this.keys.setRecoveryWrap(
          orgId,
          space.id,
          v.version,
          v.wrappedKey,
          fingerprint,
        );
      }
      const versions = ordered.map((v) => v.version);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.recovery_rewrapped',
        metadata: { spaceId: space.id, versions },
      });
      return { versions };
    });
  }
}
