import { Injectable } from '@nestjs/common';
import { ConflictError } from '../../shared/domain/errors.js';
import { LinkCode } from '../domain/link-code.js';
import { LinkCodeRepository } from '../domain/link-code.repository.js';
import { HubCodeHasher } from './ports/hub-code-hasher.js';

const MAX_CODE_ATTEMPTS = 5;

export type LinkCodeResult = {
  /** 8 digits, single use, valid for 10 min. Shown or spoken by the hub; only its keyed hash is stored. */
  linkCode: string;
  expiresAt: Date;
};

// O Hub autenticado pede um código de vínculo (`POST /hub/link-codes`, spec §4.6; o guard já conferiu o Hub).
// Antes, os códigos vencidos e não usados ganham lápide (libera o hash, que é único só entre os vigentes); uma
// colisão rara com um código vigente sorteia outro, até 5 tentativas (como a apresentação). Cada INSERT em
// autocommit: uma colisão não aborta transação nenhuma.
@Injectable()
export class IssueLinkCodeUseCase {
  constructor(
    private readonly linkCodes: LinkCodeRepository,
    private readonly codes: HubCodeHasher,
  ) {}

  async execute(hubId: string): Promise<LinkCodeResult> {
    const now = new Date();
    await this.linkCodes.expireStale(now);
    for (let attempt = 1; ; attempt++) {
      const linkCode = this.codes.newCode();
      const code = LinkCode.issue({
        hubId,
        codeHash: await this.codes.hashLinkCode(linkCode),
        now,
      });
      try {
        await this.linkCodes.create(code);
      } catch (error) {
        if (
          error instanceof ConflictError &&
          error.code === 'link-code-collision' &&
          attempt < MAX_CODE_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
      return { linkCode, expiresAt: code.expiresAt };
    }
  }
}
