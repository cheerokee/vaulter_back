import type { OrgRoleKey } from '../../domain/membership.js';

/** What every member sees about the others (publicKey is public by nature; spaces will need it). */
export type MemberView = {
  userId: string;
  name: string;
  email: string;
  publicKey: string;
  roleKey: OrgRoleKey;
  joinedAt: Date | null;
};
