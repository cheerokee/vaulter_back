import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { ServerKeyCopyCheck } from '../../shared/application/server-key-copy-check.js';
import { SpaceKeyRotatedHooks } from '../../shared/application/space-key-rotated-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { KeyRotationRules } from '../domain/key-rotation.js';
import { assertRecoveryPublicKey } from '../domain/recovery-public-key.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRoomRepository } from '../domain/space-room.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { assertWrappedKeys } from './dto/key-inputs.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

export type RotateSpaceKeyInput = {
  /** Must be current_key_version + 1. */
  version: number;
  recoveryPublicKey: string;
  recoveryWrappedKey: string;
  /** Exactly one copy per ACTIVE member of the space. */
  grants: { userId: string; wrappedKey: string }[];
  /** Exactly one copy per hub with the space open in its Room (empty when there is none). */
  hubGrants: { hubId: string; wrappedKey: string }[];
  /** The new version sealed for the server key: required exactly when the space is in `active_cloud`. */
  serverWrappedKey?: string | null;
};

// Nova versão da chave (decisão 6). Com troca pendente (`keyRotationRequired`), qualquer membro ativo; sem ela,
// só o Gestor (troca manual, ex.: suspeita de vazamento) — senão 409 `key-rotation-not-required`, o que limita
// o número de versões (pôr membro, retrancar e reabrir mandam todas num pedido só). Com o espaço travado:
// versão = atual + 1 e o conjunto de destinatários = exatamente os membros ativos lidos sob o lock (quem saiu
// não recebe a versão nova; quem entrou no meio não fica de fora), e o mesmo para os Hubs da Sala (spec hubs
// §6: um Hub tirado da Sala não recebe a versão nova). Divergência: 409 `key-rotation-mismatch`, para o app
// recarregar. Espaço em nuvem ativa: a troca leva também a cópia para a chave do servidor (sem ela, 409
// `key-rotation-mismatch` com `missingServer: true`; fora da nuvem ativa, `unexpectedServer: true`), entregue ao
// `cloud` pelo gancho `SpaceKeyRotatedHooks` na mesma transação (ele confere que abre e a guarda; erro desfaz tudo).
// A auditoria leva só a versão.
@Injectable()
export class RotateSpaceKeyUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly room: SpaceRoomRepository,
    private readonly audit: AuditLog,
    private readonly rotated: SpaceKeyRotatedHooks,
    private readonly uow: UnitOfWork,
    private readonly serverCopies: ServerKeyCopyCheck,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: RotateSpaceKeyInput,
  ): Promise<{ currentVersion: number }> {
    assertRecoveryPublicKey(input.recoveryPublicKey);
    const serverWrappedKey = input.serverWrappedKey ?? null;
    assertWrappedKeys([
      input.recoveryWrappedKey,
      ...(serverWrappedKey !== null ? [serverWrappedKey] : []),
      ...input.grants.map((g) => g.wrappedKey),
      ...input.hubGrants.map((g) => g.wrappedKey),
    ]);
    // The `cloud` hook checks the server copy under the space lock: load the server keys (KMS) before it.
    if (serverWrappedKey !== null) await this.serverCopies.prepare();
    return this.uow.run(async () => {
      const { space, roleKey } = await this.access.lockAsMember(
        spaceId,
        actor.userId,
      );
      // Sob o lock: sem troca pendente, só o Gestor troca (409 `key-rotation-not-required`).
      space.assertRotationAllowed(roleKey === 'space_manager');
      const orgId = space.organizationId;
      const fingerprint = await this.kit.assertCurrent(
        orgId,
        input.recoveryPublicKey,
      );
      // Só em memória até aqui: lança `key-rotation-mismatch` se a versão não for a seguinte.
      space.completeRotation(input.version);
      KeyRotationRules.assertGrantsMatchMembers(
        input.grants.map((g) => g.userId),
        await this.roles.activeMemberIds(orgId, space.id),
      );
      KeyRotationRules.assertHubGrantsMatchRoom(
        input.hubGrants.map((g) => g.hubId),
        await this.room.roomHubIds(orgId, space.id),
      );
      // Lido sob o lock: ligar/desligar a nuvem trava o mesmo espaço FOR UPDATE.
      KeyRotationRules.assertServerGrantMatchesCloud(
        serverWrappedKey !== null,
        space.cloudMode === 'active_cloud',
      );
      const key = await this.keys.addVersion(
        orgId,
        space.id,
        input.version,
        input.recoveryWrappedKey,
        fingerprint,
      );
      for (const grant of input.grants) {
        await this.grants.upsert(orgId, key.id, grant.userId, grant.wrappedKey);
      }
      for (const grant of input.hubGrants) {
        await this.room.upsertHubGrant(
          orgId,
          key.id,
          grant.hubId,
          grant.wrappedKey,
        );
      }
      await this.spaces.save(space);
      await this.rotated.run({
        organizationId: orgId,
        spaceId: space.id,
        spaceKeyId: key.id,
        version: input.version,
        serverWrappedKey,
        actorUserId: actor.userId,
      });
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.key_rotated',
        metadata: { spaceId: space.id, version: input.version },
      });
      return { currentVersion: space.currentKeyVersion };
    });
  }
}
