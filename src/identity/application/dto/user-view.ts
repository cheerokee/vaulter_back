import type { User } from '../../domain/user.js';

export type UserView = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
};

export function toUserView(user: User): UserView {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt ?? new Date(0),
  };
}
