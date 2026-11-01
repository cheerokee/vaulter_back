import { LinkCode } from '../../domain/link-code.js';
import type { HubLinkCodeTypeormEntity } from './hub-link-code.entity.js';

/** Raw row of `RETURNING *` on hub_link_codes. */
export type LinkCodeRow = {
  id: string;
  hub_id: string;
  code_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

export const LinkCodeMapper = {
  fromRow(row: LinkCodeRow): LinkCode {
    return LinkCode.restore(
      {
        hubId: row.hub_id,
        codeHash: row.code_hash,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        createdAt: row.created_at,
      },
      row.id,
    );
  },

  toPersistence(code: LinkCode): Partial<HubLinkCodeTypeormEntity> {
    return {
      id: code.id,
      hubId: code.hubId,
      codeHash: code.codeHash,
      expiresAt: code.expiresAt,
      usedAt: code.usedAt,
    };
  },
};
