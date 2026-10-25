import { Injectable } from '@nestjs/common';
import { DomainValidationError } from '../domain/errors.js';

export type InvitationSpaceRoleKey =
  'space_reader' | 'space_editor' | 'space_manager';

export type InvitationSpaceIntent = {
  spaceId: string;
  roleKey: InvitationSpaceRoleKey;
};

export type InvitationCreatedContext = {
  organizationId: string;
  invitationId: string;
  actorId: string;
  /** Never empty: the registry is only called when the invitation indicates spaces. */
  spaces: InvitationSpaceIntent[];
};

export type InvitationAcceptedContext = {
  organizationId: string;
  invitationId: string;
  /** The person who accepted (a new member, or one who already was: the invitation was just consumed). */
  userId: string;
  now: Date;
};

export type InvitationHook = {
  name: string;
  /** Validates the intents (throws on invalid) and records them; runs in the invitation's unit of work. */
  validateAndRecord(ctx: InvitationCreatedContext): Promise<void>;
  /** Runs in the acceptance unit of work, after the membership exists (or was already there). */
  onAccepted(ctx: InvitationAcceptedContext): Promise<void>;
};

// Registro global de ganchos de convite, assinado por módulos dependentes (ex.: `spaces`).
// Sem nenhum inscrito, convite com espaços é recusado (`spaces-not-supported`): a intenção nunca some em silêncio.
@Injectable()
export class InvitationHooks {
  private readonly hooks: InvitationHook[] = [];

  register(hook: InvitationHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(`Invitation hook "${hook.name}" is already registered.`);
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async validateAndRecord(ctx: InvitationCreatedContext): Promise<void> {
    if (this.hooks.length === 0) {
      throw new DomainValidationError(
        'spaces-not-supported',
        'Invitations to spaces are not supported.',
      );
    }
    for (const hook of this.hooks) await hook.validateAndRecord(ctx);
  }

  async onAccepted(ctx: InvitationAcceptedContext): Promise<void> {
    for (const hook of this.hooks) await hook.onAccepted(ctx);
  }
}
