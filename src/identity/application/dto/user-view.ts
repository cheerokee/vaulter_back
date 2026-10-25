import type { User } from '../../domain/user.js';

export type UserView = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
};

export function toUserView(user: User): UserView {
  if (!user.createdAt) {
    throw new Error('User without createdAt cannot be viewed');
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}
