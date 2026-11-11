import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { SpaceCloudDeactivatedHooks } from '../../shared/application/space-cloud-deactivated-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../spaces/application/space-cloud.js';
import type { Space } from '../../spaces/domain/space.js';
import { CloudTermRules } from '../domain/cloud-term.js';
import {
  CloudTermAcceptanceRepository,
  CloudTermRepository,
  ServerKeyGrantRepository,
  SpaceActivationRepository,
} from '../domain/cloud.repositories.js';
import { parseSealedCopy } from '../domain/sealed-copy.js';
import {
  SpaceActivation,
  SpaceActivationRules,
} from '../domain/space-activation.js';
import { CloudSpaceAccess } from './cloud-space-access.js';
import { CloudSpaceJobs } from './cloud-space-jobs.js';
import {
  CloudChunkRepository,
  CloudFileRepository,
} from '../domain/indexing.repositories.js';
import { CloudIndexingQueue } from './indexing/cloud-indexing-queue.js';
import {
  toSpaceCloudStateView,
  type SpaceCloudStateView,
} from './dto/cloud-views.js';
import { ServerKeyring } from './ports/server-keyring.js';
import { assertOpensWithServerKey } from './server-copy.js';

/** The organization accepted the current term (422 `cloud-terms-not-accepted` otherwise); returns its version. */
async function requireCurrentTermAccepted(
  terms: CloudTermRepository,
  acceptances: CloudTermAcceptanceRepository,
  orgId: string,
): Promise<number> {
  return CloudTermRules.assertCurrentAccepted(
    await terms.current(),
    await acceptances.latest(orgId),
  ).version;
}

// Estado da nuvem ativa de um espaço (ciclo vivo), para todo membro do espaço e para quem decide (o Gestor sabe que
// pode mandar a chave; o admin vê o que autorizou). O resto: 404 `space-not-found`.
@Injectable()
export class GetSpaceCloudUseCase {
  constructor(
    private readonly access: CloudSpaceAccess,
    private readonly activations: SpaceActivationRepository,
  ) {}

  async execute(actor: Actor, spaceId: string): Promise<SpaceCloudStateView> {
    const space = await this.access.findForViewer(spaceId, actor.userId);
    return toSpaceCloudStateView(
      space.id,
      await this.activations.findLive(space.organizationId, space.id),
    );
  }
}

// Passo 1 (spec active-cloud §4.1): quem decide autoriza o espaço. Exige o termo ATUAL aceito pela organização,
// `allow_online_llm` ligado, alguém no espaço para mandar a chave (órfão nunca liga) e orçamento mensal de IA > 0
// (422 `ai-budget-required`; leitura sem trava: o orçamento mudar logo depois só faz a nuvem esperar). Espaço já autorizado ou ativo:
// devolve o estado, sem gravar (idempotente). Travas: espaço FOR UPDATE (lockWithOrgPermission) -> ciclo vivo FOR
// UPDATE. Auditado `space.cloud.authorized`.
@Injectable()
export class AuthorizeSpaceCloudUseCase {
  constructor(
    private readonly access: CloudSpaceAccess,
    private readonly terms: CloudTermRepository,
    private readonly acceptances: CloudTermAcceptanceRepository,
    private readonly activations: SpaceActivationRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly directory: OrganizationDirectory,
  ) {}

  async execute(actor: Actor, spaceId: string): Promise<SpaceCloudStateView> {
    return this.uow.run(async () => {
      const space = await this.access.lockAsDecider(spaceId, actor.userId);
      const orgId = space.organizationId;
      const live = await this.activations.lockLive(orgId, space.id);
      if (live) return toSpaceCloudStateView(space.id, live);
      const termVersion = await requireCurrentTermAccepted(
        this.terms,
        this.acceptances,
        orgId,
      );
      SpaceActivationRules.assertCanAuthorize({
        allowOnlineLlm: space.allowOnlineLlm,
        memberCount: await this.access.memberCount(orgId, space.id),
      });
      SpaceActivationRules.assertAiBudgetSet(
        await this.directory.aiBudget(orgId),
      );
      const activation = SpaceActivation.authorize({
        organizationId: orgId,
        spaceId: space.id,
        termVersion,
        byUserId: actor.userId,
        at: new Date(),
      });
      await this.activations.insert(activation);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.cloud.authorized',
        metadata: { spaceId: space.id, termVersion },
      });
      return toSpaceCloudStateView(space.id, activation);
    });
  }
}

export type ActivateSpaceCloudInput = {
  /** Every key version of the space sealed for the server key (`GET /cloud/server-key`). */
  serverGrants: { version: number; wrappedKey: string }[];
};

// Passo 2: o Gestor (membro com a chave; o admin fora do espaço recebe 404) manda a cópia de TODAS as versões para a
// chave do servidor e o espaço passa a `active_cloud`. Exige o ciclo autorizado (422 `cloud-not-authorized`; já
// ativo: 409 `cloud-already-active`), o termo atual aceito e `allow_online_llm` (conferidos de novo: um termo novo
// publicado depois da autorização precisa de aceite antes de ligar). Cada cópia é aberta com a chave do servidor
// (prova que foi selada para ela; 422 `server-copy-invalid`) e a chave aberta é apagada da memória na hora. Travas:
// espaço FOR UPDATE -> ciclo vivo FOR UPDATE -> cópias. Auditado `space.cloud.activated` (só ids e a contagem).
@Injectable()
export class ActivateSpaceCloudUseCase {
  constructor(
    private readonly access: CloudSpaceAccess,
    private readonly spaceCloud: SpaceCloud,
    private readonly terms: CloudTermRepository,
    private readonly acceptances: CloudTermAcceptanceRepository,
    private readonly activations: SpaceActivationRepository,
    private readonly grants: ServerKeyGrantRepository,
    private readonly keyring: ServerKeyring,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly indexing: CloudIndexingQueue,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: ActivateSpaceCloudInput,
  ): Promise<SpaceCloudStateView> {
    for (const g of input.serverGrants) parseSealedCopy(g.wrappedKey);
    return this.uow.run(async () => {
      const space = await this.access.lockAsManager(spaceId, actor.userId);
      const orgId = space.organizationId;
      const activation = SpaceActivationRules.assertAuthorized(
        await this.activations.lockLive(orgId, space.id),
      );
      const now = new Date();
      activation.activate(actor.userId, now);
      await requireCurrentTermAccepted(this.terms, this.acceptances, orgId);
      SpaceActivationRules.assertCanAuthorize({
        allowOnlineLlm: space.allowOnlineLlm,
        memberCount: 1, // quem liga é o Gestor, membro do espaço
      });
      const versions = await this.spaceCloud.keyVersions(orgId, space.id);
      SpaceActivationRules.assertCoversVersions(
        input.serverGrants.map((g) => g.version),
        versions.map((v) => v.version),
      );
      const keyIdByVersion = new Map(versions.map((v) => [v.version, v.id]));
      for (const g of input.serverGrants) {
        await assertOpensWithServerKey(this.keyring, g.wrappedKey);
        await this.grants.insert({
          organizationId: orgId,
          spaceId: space.id,
          spaceKeyId: keyIdByVersion.get(g.version)!,
          keyVersion: g.version,
          wrappedKey: g.wrappedKey,
        });
      }
      await this.activations.save(activation);
      await this.spaceCloud.markActive(orgId, space.id, now);
      // Indexação inicial (pg-boss), na mesma transação (some se ela desfizer).
      await this.indexing.enqueueSpace(orgId, space.id, { debounce: false });
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.cloud.activated',
        metadata: { spaceId: space.id, keyVersions: versions.length },
      });
      return toSpaceCloudStateView(space.id, activation);
    });
  }
}

// Desligar (quem decide ou o Gestor): APAGA de verdade o que é legível (as cópias da chave do espaço para o servidor,
// os trechos com os embeddings e os arquivos com nome/tipo, neste mesmo unit of work; e, pelo gancho
// `SpaceCloudDeactivatedHooks`, as cópias da chave de cada assunto para o servidor, com a nuvem de reserva desligada), cancela as tarefas da nuvem que
// ainda esperam (`CloudSpaceJobs`), encerra o ciclo (lápide com quem desligou) e volta o espaço a `encrypted_backup`.
// Uma tarefa já RODANDO (com a chave aberta) não grava depois disto: ela confere o espaço FOR SHARE na transação em que
// grava (`SpaceCloud.lockActiveForWrite`), e esta segura o espaço FOR UPDATE até o COMMIT.
// O backup cifrado não muda. Desligar um espaço autorizado e ainda não ligado cancela a autorização. Nada vivo:
// idempotente (sem gravar nem auditar). Travas: espaço FOR UPDATE -> ciclo vivo FOR UPDATE -> cópias. Auditado
// `space.cloud.deactivated`.
@Injectable()
export class DeactivateSpaceCloudUseCase {
  constructor(
    private readonly access: CloudSpaceAccess,
    private readonly spaceCloud: SpaceCloud,
    private readonly activations: SpaceActivationRepository,
    private readonly grants: ServerKeyGrantRepository,
    private readonly jobs: CloudSpaceJobs,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly files: CloudFileRepository,
    private readonly chunks: CloudChunkRepository,
    private readonly deactivated: SpaceCloudDeactivatedHooks,
  ) {}

  async execute(actor: Actor, spaceId: string): Promise<void> {
    await this.uow.run(async () => {
      const space = await this.access.lockAsManagerOrDecider(
        spaceId,
        actor.userId,
      );
      await this.switchOff(space, actor.userId);
    });
  }

  private async switchOff(space: Space, userId: string): Promise<void> {
    const orgId = space.organizationId;
    const live = await this.activations.lockLive(orgId, space.id);
    const wasActive = space.cloudMode === 'active_cloud';
    if (!live && !wasActive) return;
    const serverCopiesDeleted = await this.grants.deleteForSpace(
      orgId,
      space.id,
    );
    const chunksDeleted = await this.chunks.deleteForSpace(orgId, space.id);
    const filesDeleted = await this.files.deleteForSpace(orgId, space.id);
    const jobsCancelled = await this.jobs.cancelForSpace(space.id);
    const now = new Date();
    if (live) await this.activations.end(live, userId, now);
    if (wasActive) await this.spaceCloud.markEncryptedBackup(orgId, space.id);
    // The cloud stops being the reserve executor of the space's conversations (`conversations` deletes their server
    // copies and marks their key rotation), in this same unit of work, with the space still locked FOR UPDATE.
    await this.deactivated.run({
      organizationId: orgId,
      spaceId: space.id,
      actorUserId: userId,
      now,
    });
    await this.audit.record({
      organizationId: orgId,
      userId,
      action: 'space.cloud.deactivated',
      metadata: {
        spaceId: space.id,
        previousState: live?.state ?? 'active',
        serverCopiesDeleted,
        chunksDeleted,
        filesDeleted,
        jobsCancelled,
      },
    });
  }
}
