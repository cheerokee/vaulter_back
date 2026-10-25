import { User } from '../../domain/user.js';
import { UserTypeormEntity } from './user.entity.js';

export const UserMapper = {
  toDomain(row: UserTypeormEntity): User {
    return User.restore(
      {
        name: row.name,
        email: row.email,
        authHash: row.authHash,
        kdfSalt: row.kdfSalt,
        kdfParams: row.kdfParams,
        publicKey: row.publicKey,
        encryptedPrivateKey: row.encryptedPrivateKey,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? undefined,
      },
      row.id,
    );
  },

  // createdAt/updatedAt e syncVersion ficam com o banco.
  toPersistence(user: User): Partial<UserTypeormEntity> {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      authHash: user.authHash,
      kdfSalt: user.kdfSalt,
      kdfParams: user.kdfParams,
      publicKey: user.publicKey,
      encryptedPrivateKey: user.encryptedPrivateKey,
    };
  },
};
