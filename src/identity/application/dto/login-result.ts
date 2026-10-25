import type { KdfParams } from '../../domain/kdf-params.js';
import type { User } from '../../domain/user.js';
import type { SessionTokens } from './session-tokens.js';
import { toUserView, type UserView } from './user-view.js';

export type LoginResult = {
  user: UserView;
  keys: {
    publicKey: string;
    encryptedPrivateKey: string;
    kdfSalt: string;
    kdfParams: KdfParams;
  };
  session: SessionTokens;
  /** Only present when an invite token was sent at registration (or a hook reported it). */
  invitation?: { accepted: boolean };
};

export function toLoginResult(user: User, tokens: SessionTokens): LoginResult {
  return {
    user: toUserView(user),
    keys: {
      publicKey: user.publicKey,
      encryptedPrivateKey: user.encryptedPrivateKey,
      kdfSalt: user.kdfSalt,
      kdfParams: user.kdfParams,
    },
    session: tokens,
  };
}
