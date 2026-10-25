import { Injectable } from '@nestjs/common';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { InvitationRepository } from '../domain/invitation.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import type { InvitationPreview } from './dto/invitation-view.js';
import { invitationInvalid } from './invitation-errors.js';
import { InvitationTokenCodec } from './ports/invitation-token-codec.js';

// Prévia pública (o link pode vazar): só o nome da organização, o NOME de quem convidou e a validade.
// Nenhum e-mail. Qualquer convite que não vale dá o mesmo `invitation-invalid`.
@Injectable()
export class PreviewInvitationUseCase {
  constructor(
    private readonly codec: InvitationTokenCodec,
    private readonly invitations: InvitationRepository,
    private readonly orgs: OrganizationRepository,
    private readonly directory: UserDirectory,
  ) {}

  async execute(token: string): Promise<InvitationPreview> {
    const tokenHash = this.codec.hash(token);
    if (tokenHash === null) throw invitationInvalid();
    const invitation = await this.invitations.findByTokenHash(tokenHash);
    if (!invitation || invitation.effectiveStatus(new Date()) !== 'pending') {
      throw invitationInvalid();
    }
    // O repositório lê no contexto da organização do convite (quem pede não é membro).
    const org = await this.orgs.findById(invitation.organizationId);
    if (!org) throw invitationInvalid();
    const [inviter] = await this.directory.findPublicByIds([
      invitation.createdBy,
    ]);
    return {
      organizationName: org.name,
      invitedByName: inviter?.name ?? null,
      expiresAt: invitation.expiresAt,
    };
  }
}
