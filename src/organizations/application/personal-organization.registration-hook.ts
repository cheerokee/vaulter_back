import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  RegistrationHooks,
  type RegistrationHookContext,
  type RegistrationHookResult,
} from '../../shared/application/registration-hooks.js';
import { DomainError } from '../../shared/domain/errors.js';
import { AcceptInvitationUseCase } from './accept-invitation.use-case.js';
import { CreateOrganizationUseCase } from './create-organization.use-case.js';

const HOOK_NAME = 'organizations.personal';

// Cadastro: cria a organização pessoal (dono = admin) e, se veio `inviteToken`, tenta o aceite com o e-mail da
// conta nova. Roda dentro da transação do cadastro (RegisterUserUseCase).
// - Convite que não vale (inválido, expirado, usado, outro e-mail, sem assento): `accepted: false`, sem lançar.
//   `acceptAs` já se isola sozinho (abre um `uow.run` aninhado, ou seja, um SAVEPOINT): o que a tentativa tiver
//   gravado é desfeito sozinho e a transação do cadastro segue sã. Só erros de domínio viram `accepted: false`.
// - Erro inesperado (banco, programação) sobe e desfaz o cadastro inteiro.
@Injectable()
export class PersonalOrganizationRegistrationHook
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly hooks: RegistrationHooks,
    private readonly createOrganization: CreateOrganizationUseCase,
    private readonly acceptInvitation: AcceptInvitationUseCase,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      onRegistered: (ctx) => this.onRegistered(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async onRegistered(
    ctx: RegistrationHookContext,
  ): Promise<RegistrationHookResult | void> {
    await this.createOrganization.createPersonal({
      ownerId: ctx.userId,
      name: ctx.name,
      now: ctx.now,
    });
    if (ctx.inviteToken === undefined) return;
    const token = ctx.inviteToken;
    try {
      await this.acceptInvitation.acceptAs(
        { userId: ctx.userId, email: ctx.email },
        token,
        ctx.now,
      );
      return { invitation: { accepted: true } };
    } catch (error) {
      if (error instanceof DomainError)
        return { invitation: { accepted: false } };
      throw error;
    }
  }
}
